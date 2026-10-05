/**
 * ban-openai - temporarily disable GPT (the `openai` provider).
 *
 * Reversible toggle for the OpenAI provider's model catalog. When enabled, `openai` models are
 * removed from `/model`, `--model`, scoped models, and the registry. The `router`/`supervisor`
 * roles fall back to the next credentialed candidate (`openai-codex`, then `deepseek`), and
 * `resolveRole` degrades to `daily` when no OpenAI-side provider remains.
 *
 * Config: `~/.pi/agent/ban-openai.json` -> `{ "enabled": true }`.
 * Command: `/ban-openai on|off`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type AnyModel, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai";
const CONFIG_PATH = path.join(getAgentDir(), "ban-openai.json");

function isEnabled(): boolean {
	try {
		return (JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as { enabled?: boolean }).enabled === true;
	} catch {
		return false;
	}
}

function writeEnabled(enabled: boolean): void {
	fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf-8");
}

function readCachedModels(): AnyModel[] {
	try {
		const store = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "models-store.json"), "utf-8")) as Record<
			string,
			{ models?: AnyModel[] }
		>;
		return store[PROVIDER]?.models ?? [];
	} catch {
		return [];
	}
}

function toProviderModel(model: AnyModel): Record<string, unknown> {
	const fields = [
		"id",
		"name",
		"api",
		"baseUrl",
		"input",
		"output",
		"cost",
		"reasoning",
		"thinkingLevelMap",
		"promptCache",
		"contextWindow",
		"maxTokens",
		"samplingParams",
		"samplingParamsByThinkingLevel",
		"compat",
		"inputLimits",
		"headers",
	] as const;
	const result: Record<string, unknown> = { type: (model as { type?: string }).type ?? "chat" };
	for (const field of fields) {
		const value = (model as Record<string, unknown>)[field];
		if (value !== undefined) result[field] = value;
	}
	return result;
}

export default function (pi: ExtensionAPI) {
	/** The full catalog, captured once so the toggle is reversible. */
	let base: AnyModel[] = [];

	function apply(ctx?: ExtensionContext): void {
		if (base.length === 0) {
			base = ctx ? ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER) : [];
			if (base.length === 0) base = readCachedModels();
		}
		pi.registerProvider(PROVIDER, { models: isEnabled() ? [] : (base.map(toProviderModel) as never) });
	}

	apply();

	pi.on("session_start", (_event, ctx) => {
		apply(ctx);
		if (isEnabled() && ctx.hasUI) ctx.ui.notify("ban-openai: GPT (openai) is disabled.", "info");
	});

	pi.registerCommand("ban-openai", {
		description: "Temporarily disable/enable the OpenAI (GPT) provider",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off") {
				writeEnabled(action === "on");
			} else if (action && action !== "status") {
				ctx.ui.notify("Usage: /ban-openai [status|on|off]", "warning");
				return;
			}
			apply(ctx);
			ctx.ui.notify(
				`ban-openai: ${isEnabled() ? "GPT disabled (openai catalog cleared)" : "GPT enabled (openai catalog restored)"}`,
				"info",
			);
		},
	});
}
