/**
 * Central role registry for this pi setup.
 *
 * One file, `~/.pi/agent/agent-config.json`, is the single source of truth. Every role binds a
 * model (a list of `"provider/modelId"` candidates) and, optionally, a prompt in its own
 * directory under `~/.pi/agent/roles/`.
 *
 *   {
 *     "roles": {
 *       "classifier": { "model": ["deepseek/deepseek-flash"] },
 *       "supervisor": { "model": ["openai-codex/gpt-6.1-sol", "openai/gpt-6.1-sol"] },
 *       "daily":      { "model": ["deepseek/deepseek-flash"] },
 *       "research":   { "model": ["openai-codex/gpt-6-astra", "openai/gpt-6-astra"] },
 *       "failover":   { "model": ["openai-codex/gpt-6-luna", "openai/gpt-6-luna"] },
 *       "scout": {
 *         "model": ["deepseek/deepseek-flash"],
 *         "prompt": "scout/prompt.md",
 *         "agent": { "description": "...", "tools": ["read", "grep"] }
 *       }
 *     }
 *   }
 *
 * A role resolves to the first candidate whose provider has credentials, so listing
 * `openai-codex/...` before `openai/...` follows whichever you logged into.
 *
 * Consumers (`agent-config` extension):
 *   - `classifier` -> pi-automode `autoMode.classifierModel`
 *   - `supervisor` -> `<cwd>/.pi/supervisor-config.json` `model`, and `prompt` -> `SUPERVISOR.md`
 *   - any role with `agent` -> a generated `~/.pi/agent/agents/<role>.md`
 *   - `daily` / `research` / `failover` -> read directly by the `router` extension
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CONFIG_PATH = path.join(getAgentDir(), "agent-config.json");
export const ROLES_DIR = path.join(getAgentDir(), "roles");
export const AGENTS_DIR = path.join(getAgentDir(), "agents");

export interface AgentSpec {
	description?: string;
	tools?: string[];
}

export interface RoleSpec {
	model?: string[];
	prompt?: string;
	agent?: AgentSpec;
}

export interface AgentConfig {
	roles: Record<string, RoleSpec>;
	/** Cron job name -> role name. The `agent-config` extension writes each job's model from it. */
	cron: Record<string, string>;
}

export const DEFAULT_CONFIG: AgentConfig = {
	roles: {
		classifier: { model: ["deepseek/deepseek-flash"] },
		supervisor: { model: ["openai-codex/gpt-6.1-sol", "openai/gpt-6.1-sol"] },
		session: { model: ["router/auto"] },
		daily: { model: ["deepseek/deepseek-flash"] },
		research: { model: ["openai-codex/gpt-6-astra", "openai/gpt-6-astra"] },
		failover: { model: ["openai-codex/gpt-6-luna", "openai/gpt-6-luna"] },
	},
	cron: {},
};

export interface ResolvedModel {
	provider: string;
	id: string;
	spec: string;
}

function normalizeRole(value: unknown, fallback: RoleSpec | undefined): RoleSpec {
	if (typeof value === "string") return { model: [value] };
	if (!value || typeof value !== "object") return fallback ?? {};
	const raw = value as Record<string, unknown>;
	const model = Array.isArray(raw.model)
		? raw.model.filter((entry): entry is string => typeof entry === "string")
		: typeof raw.model === "string"
			? [raw.model]
			: (fallback?.model ?? []);
	const prompt = typeof raw.prompt === "string" ? raw.prompt : fallback?.prompt;
	const agentRaw = raw.agent && typeof raw.agent === "object" ? (raw.agent as Record<string, unknown>) : undefined;
	const agent: AgentSpec | undefined = agentRaw
		? {
				description: typeof agentRaw.description === "string" ? agentRaw.description : fallback?.agent?.description,
				tools: Array.isArray(agentRaw.tools)
					? agentRaw.tools.filter((entry): entry is string => typeof entry === "string")
					: fallback?.agent?.tools,
			}
		: fallback?.agent;
	return { model, prompt, agent };
}

export function loadConfig(): AgentConfig {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
	} catch {
		raw = {};
	}
	const rawRoles = (raw.roles && typeof raw.roles === "object" ? raw.roles : {}) as Record<string, unknown>;
	const roles: Record<string, RoleSpec> = {};
	for (const [name, spec] of Object.entries(DEFAULT_CONFIG.roles)) {
		roles[name] = normalizeRole(rawRoles[name], spec);
	}
	for (const [name, spec] of Object.entries(rawRoles)) {
		if (!(name in roles)) roles[name] = normalizeRole(spec, undefined);
	}

	const rawCron = (raw.cron && typeof raw.cron === "object" ? raw.cron : {}) as Record<string, unknown>;
	const cron: Record<string, string> = {};
	for (const [job, role] of Object.entries(rawCron)) {
		if (typeof role === "string") cron[job] = role;
	}
	return { roles, cron };
}

export function parseSpec(spec: string): { provider: string; id: string } | undefined {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash >= spec.length - 1) return undefined;
	return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

/** First candidate with configured credentials, else first that exists in the catalog. */
export function resolveModel(ctx: ExtensionContext, candidates: readonly string[] | undefined): ResolvedModel | undefined {
	if (!candidates) return undefined;
	for (const spec of candidates) {
		const parsed = parseSpec(spec);
		if (!parsed) continue;
		const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return { ...parsed, spec };
	}
	for (const spec of candidates) {
		const parsed = parseSpec(spec);
		if (parsed && ctx.modelRegistry.find(parsed.provider, parsed.id)) return { ...parsed, spec };
	}
	return undefined;
}

/** Resolve a named role, falling back to the hard default for that role and then the `daily` role. */
export function resolveRole(ctx: ExtensionContext, name: string): ResolvedModel | undefined {
	const roles = loadConfig().roles;
	return (
		resolveModel(ctx, roles[name]?.model) ??
		resolveModel(ctx, DEFAULT_CONFIG.roles[name]?.model) ??
		resolveModel(ctx, roles.daily?.model) ??
		resolveModel(ctx, DEFAULT_CONFIG.roles.daily?.model)
	);
}

/** Read a role prompt file, resolved under roles/. */
export function readPrompt(relativePath: string | undefined): string | undefined {
	if (!relativePath) return undefined;
	const file = path.join(ROLES_DIR, relativePath);
	try {
		return fs.readFileSync(file, "utf-8").trim();
	} catch {
		return undefined;
	}
}
