/**
 * ban-openrouter - OpenRouter is default-deny with a whitelist.
 *
 * OpenRouter is not used on this machine. This component enforces a whitelist policy:
 * only OpenRouter models named in the whitelist are usable; every other OpenRouter chat,
 * image, and classifier model is removed from `/model`, `--model`, scoped models, the
 * model cycle, and `ctx.modelRegistry` — even when `OPENROUTER_API_KEY` is set.
 *
 * The whitelist lives in `<agent-dir>/ban-openrouter.json`:
 *
 *   {
 *     "allowedModels": ["openai/gpt-5.6-luna"],   // OpenRouter model ids
 *     "allowAll": false                            // true disables the ban entirely
 *   }
 *
 * An absent or invalid file means an empty whitelist: all of OpenRouter is blocked.
 * The catalogue is rebuilt from the cached model store, so changing the whitelist and
 * running `/ban-openrouter reload` (or restarting pi) is enough — nothing is destroyed.
 *
 * Inspect and edit it at runtime with `/ban-openrouter`:
 *   /ban-openrouter                 show status
 *   /ban-openrouter allow <id>      add a model id to the whitelist
 *   /ban-openrouter deny <id>       remove a model id from the whitelist
 *   /ban-openrouter clear           empty the whitelist (block all)
 *   /ban-openrouter reload          re-read the config and re-apply
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type AnyModel, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openrouter";
const CONFIG_PATH = path.join(getAgentDir(), "ban-openrouter.json");

/** Where a session is sent if it still names a blocked model. */
const FALLBACKS = [
	{ provider: "router", id: "auto" },
	{ provider: "deepseek", id: "deepseek-flash" },
] as const;

interface BanConfig {
	/** OpenRouter model ids that are allowed. Empty means everything is blocked. */
	allowedModels?: string[];
	/** Escape hatch: true allows every OpenRouter model. */
	allowAll?: boolean;
}

function readConfig(): { allowed: Set<string>; allowAll: boolean } {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as BanConfig;
		return {
			allowed: new Set(Array.isArray(raw.allowedModels) ? raw.allowedModels : []),
			allowAll: raw.allowAll === true,
		};
	} catch {
		return { allowed: new Set(), allowAll: false };
	}
}

function writeConfig(config: BanConfig): void {
	fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/** Read the full OpenRouter catalogue from the cached model store. */
function readCachedModels(): AnyModel[] {
	try {
		const store = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "models-store.json"), "utf-8")) as {
			openrouter?: { models?: AnyModel[] };
		};
		return store.openrouter?.models ?? [];
	} catch {
		return [];
	}
}

/** Keep only the fields a provider model definition accepts. */
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

function isBlocked(model: { provider: string; id: string }, config: { allowed: Set<string>; allowAll: boolean }): boolean {
	if (model.provider !== PROVIDER) return false;
	return !config.allowAll && !config.allowed.has(model.id);
}

export default function (pi: ExtensionAPI) {
	/** Full OpenRouter catalogue captured before it is filtered. */
	let base: AnyModel[] = [];

	/** Rebuild the OpenRouter catalog to contain only whitelisted models. */
	function apply(ctx?: ExtensionContext): void {
		if (base.length === 0) {
			base = ctx ? ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER) : [];
			if (base.length === 0) base = readCachedModels();
		}

		const config = readConfig();
		const kept = config.allowAll ? base : base.filter((model) => config.allowed.has(model.id));
		pi.registerProvider(PROVIDER, { models: kept.map(toProviderModel) as never });
	}

	async function moveToFallback(ctx: ExtensionContext): Promise<boolean> {
		const fallback = FALLBACKS.map((target) => ctx.modelRegistry.find(target.provider, target.id)).find(
			(model) => model !== undefined,
		);
		return fallback ? pi.setModel(fallback) : false;
	}

	// Apply immediately at load (from the cached catalogue), then again on each session start.
	apply();

	// Apply as early as the registry is available, and on every session boundary.
	pi.on("session_start", async (_event, ctx) => {
		apply(ctx);
		const config = readConfig();
		const selected = ctx.model;
		if (selected && isBlocked(selected, config)) {
			const switched = await moveToFallback(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(
					switched
						? `${PROVIDER}/${selected.id} is not whitelisted; switched to a fallback model.`
						: `${PROVIDER}/${selected.id} is not whitelisted.`,
					"warning",
				);
			}
		}
	});

	// Defence in depth: catch a selection that still names a blocked provider.
	pi.on("model_select", async (event, ctx) => {
		const config = readConfig();
		if (!isBlocked(event.model, config)) return;
		const fallback = FALLBACKS.map((target) => ctx.modelRegistry.find(target.provider, target.id)).find(
			(model) => model !== undefined,
		);
		const switched = fallback ? await pi.setModel(fallback) : false;
		if (ctx.hasUI) {
			ctx.ui.notify(
				switched && fallback
					? `${PROVIDER}/${event.model.id} is not whitelisted; switched to ${fallback.provider}/${fallback.id}.`
					: `${PROVIDER}/${event.model.id} is not whitelisted. Select another model.`,
				"warning",
			);
		}
	});

	pi.registerCommand("ban-openrouter", {
		description: "Show or edit the OpenRouter whitelist",
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().split(/\s+/);
			const id = rest.join(" ").trim();
			const config = readConfig();

			if (action === "allow" && id) {
				config.allowed.add(id);
				writeConfig({ allowedModels: [...config.allowed], allowAll: config.allowAll });
			} else if ((action === "deny" || action === "remove") && id) {
				config.allowed.delete(id);
				writeConfig({ allowedModels: [...config.allowed], allowAll: config.allowAll });
			} else if (action === "clear") {
				writeConfig({ allowedModels: [], allowAll: config.allowAll });
			} else if (action === "allow-all") {
				writeConfig({ allowedModels: [...config.allowed], allowAll: true });
			} else if (action === "reload") {
				// re-read below
			} else if (action && action !== "status") {
				ctx.ui.notify(
					"Usage: /ban-openrouter [status|reload|allow <id>|deny <id>|clear|allow-all]",
					"warning",
				);
				return;
			}

			const current = readConfig();
			apply(ctx);
			const whitelist = current.allowAll
				? "ALL OpenRouter models are allowed"
				: current.allowed.size > 0
					? `whitelist: ${[...current.allowed].join(", ")}`
					: "whitelist is empty — all OpenRouter models are blocked";
			ctx.ui.notify(`${PROVIDER}: ${whitelist}\nconfig: ${CONFIG_PATH}`, "info");
		},
	});
}
