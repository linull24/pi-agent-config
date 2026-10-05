/**
 * web-search - native web search for the agent, with three backends.
 *
 * Backends are tried in the order listed by the `websearch` role in
 * `~/.pi/agent/agent-config.json` (default below):
 *
 *   1. `deepseek/deepseek-flash` - DeepSeek's native server-side search, exposed as the Anthropic
 *      Messages API server tool `web_search_20250305` on `https://api.deepseek.com/anthropic/v1`.
 *      Returns structured `web_search_tool_result` blocks.
 *   2. `openai/gpt-6-luna`       - OpenAI's official Responses API `web_search` tool.
 *   3. `duckduckgo`              - keyless HTML fallback, no provider credentials needed.
 *
 * A `provider/model` entry needs credentials; a bare name (e.g. `duckduckgo`) is a keyless
 * backend. The first backend that returns sources wins; the rest are fallbacks.
 *
 * The tool is `web_search(query, maxResults?)`.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, parseSpec, type ResolvedModel } from "../_shared/roles.ts";

const DEEPSEEK_URL = "https://api.deepseek.com/anthropic/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/responses";
const DDG_URL = "https://html.duckduckgo.com/html/";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const DEFAULT_BACKENDS = ["deepseek/deepseek-flash", "openai/gpt-6-luna", "duckduckgo"];

interface Source {
	url: string;
	title: string;
	pageAge?: string | null;
}

interface SearchOutcome {
	backend: string;
	model?: string;
	answer?: string;
	sources: Source[];
}

function limit<T>(list: T[], max: number): T[] {
	return max > 0 ? list.slice(0, max) : list;
}

async function authHeaders(ctx: ExtensionContext, model: ResolvedModel): Promise<Record<string, string>> {
	const found = ctx.modelRegistry.find(model.provider, model.id);
	if (!found) throw new Error(`model ${model.spec} is not in the catalog`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(found);
	if (!auth.ok) throw new Error(auth.error);
	return { "content-type": "application/json", ...(auth.headers ?? {}), ...(auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : {}) };
}

/** DeepSeek native search via the Anthropic-compatible Messages API. */
async function searchDeepseek(
	ctx: ExtensionContext,
	model: ResolvedModel,
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	const headers = await authHeaders(ctx, model);
	const response = await fetch(DEEPSEEK_URL, {
		method: "POST",
		headers: { ...headers, "anthropic-version": "2023-06-01", "x-api-key": headers.authorization?.slice(7) ?? "" },
		body: JSON.stringify({
			model: model.id,
			max_tokens: 4096,
			messages: [{ role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${query}` }] }],
			tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
		}),
		signal,
	});
	const data = (await response.json()) as {
		content?: Array<{ type?: string; text?: string; content?: Array<{ url?: string; title?: string; page_age?: string }> }>;
		error?: unknown;
	};
	if (!response.ok) throw new Error(`deepseek ${response.status}: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);

	const sources: Source[] = [];
	let answer = "";
	for (const block of data.content ?? []) {
		if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
			for (const result of block.content) {
				if (result.url) sources.push({ url: result.url, title: result.title ?? result.url, pageAge: result.page_age ?? null });
			}
		}
		if (block.type === "text" && block.text) answer += block.text;
	}
	return { backend: "deepseek", model: model.spec, answer: answer.trim() || undefined, sources: limit(sources, maxResults) };
}

/** OpenAI official search via the Responses API `web_search` tool. */
async function searchOpenAI(
	ctx: ExtensionContext,
	model: ResolvedModel,
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	const headers = await authHeaders(ctx, model);
	const response = await fetch(OPENAI_URL, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: model.id, input: query, tools: [{ type: "web_search" }] }),
		signal,
	});
	const data = (await response.json()) as {
		output?: Array<{
			type?: string;
			content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> }>;
		}>;
		error?: { message?: string };
	};
	if (!response.ok) throw new Error(`openai ${response.status}: ${data.error?.message ?? JSON.stringify(data).slice(0, 300)}`);

	const sources: Source[] = [];
	let answer = "";
	for (const item of data.output ?? []) {
		for (const part of item.content ?? []) {
			if (part.text) answer += part.text;
			for (const annotation of part.annotations ?? []) {
				if (annotation.type === "url_citation" && annotation.url) {
					sources.push({ url: annotation.url, title: annotation.title ?? annotation.url, pageAge: null });
				}
			}
		}
	}
	return { backend: "openai", model: model.spec, answer: answer.trim() || undefined, sources: limit(sources, maxResults) };
}

/** Keyless DuckDuckGo HTML fallback. */
async function searchDuckDuckGo(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchOutcome> {
	const response = await fetch(`${DDG_URL}?q=${encodeURIComponent(query)}`, {
		headers: { "user-agent": USER_AGENT, accept: "text/html" },
		signal,
	});
	const html = await response.text();
	if (!response.ok) throw new Error(`duckduckgo ${response.status}`);

	const sources: Source[] = [];
	const seen = new Set<string>();
	const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	for (const match of html.matchAll(pattern)) {
		let url = match[1];
		const decoded = /[?&]uddg=([^&]+)/.exec(url);
		if (decoded) url = decodeURIComponent(decoded[1]);
		const title = match[2].replace(/<[^>]+>/g, "").trim();
		if (!url.startsWith("http") || seen.has(url)) continue;
		seen.add(url);
		sources.push({ url, title: title || url, pageAge: null });
		if (sources.length >= maxResults) break;
	}
	return { backend: "duckduckgo", sources };
}

async function runBackend(
	ctx: ExtensionContext,
	spec: string,
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	const parsed = parseSpec(spec);
	if (!parsed) return searchDuckDuckGo(query, maxResults, signal); // bare name -> keyless backend
	if (parsed.provider === "deepseek") return searchDeepseek(ctx, { ...parsed, spec }, query, maxResults, signal);
	if (parsed.provider === "openai" || parsed.provider === "openai-codex") {
		return searchOpenAI(ctx, { ...parsed, spec }, query, maxResults, signal);
	}
	return searchDuckDuckGo(query, maxResults, signal);
}

function format(outcome: SearchOutcome): string {
	const lines: string[] = [];
	if (outcome.answer) lines.push(outcome.answer, "");
	lines.push(`Sources (${outcome.backend}${outcome.model ? ` · ${outcome.model}` : ""}):`);
	if (outcome.sources.length === 0) lines.push("- (none)");
	for (const source of outcome.sources) {
		lines.push(`- ${source.title}${source.pageAge ? ` (${source.pageAge})` : ""}\n  ${source.url}`);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and return an answer with structured sources. Tries the configured backends in order: DeepSeek native search, OpenAI Responses web search, then a keyless DuckDuckGo fallback.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			maxResults: Type.Optional(Type.Number({ description: "Maximum number of sources to return (default 8)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query;
			const maxResults = params.maxResults ?? 8;
			const candidates = loadConfig().roles.websearch?.model ?? DEFAULT_BACKENDS;
			const errors: string[] = [];

			for (const spec of candidates) {
				if (signal?.aborted) break;
				try {
					const outcome = await runBackend(ctx, spec, query, maxResults, signal);
					if (outcome.sources.length === 0 && !outcome.answer) throw new Error("no results");
					return { content: [{ type: "text", text: format(outcome) }], details: outcome };
				} catch (error) {
					errors.push(`${spec}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			return {
				content: [{ type: "text", text: `web_search failed on every backend:\n${errors.join("\n")}` }],
				details: { query, errors },
			};
		},
	});
}
