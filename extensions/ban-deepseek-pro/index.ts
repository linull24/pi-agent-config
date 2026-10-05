/**
 * ban-deepseek-pro - hard-ban DeepSeek V4 Pro locally.
 *
 * `deepseek/deepseek-v4-pro` is removed from the catalog, so it disappears from `/model`,
 * `--model`, scoped models, the model cycle, and `ctx.modelRegistry`. It cannot be selected at
 * all, manually or automatically. `deepseek/deepseek-flash` stays available and is the fallback
 * if a session still names the banned model (for example a resumed session).
 *
 * To allow it again, remove its entry from BANNED_MODELS.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type AnyModel, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

interface BannedModel {
	provider: string;
	id: string;
}

/** Models that must never be used. */
const BANNED_MODELS: BannedModel[] = [{ provider: "deepseek", id: "deepseek-v4-pro" }];

/** Where a session is sent if it still names a banned model. */
const FALLBACK: { provider: string; id: string } = { provider: "deepseek", id: "deepseek-flash" };

function bannedIdsFor(provider: string): Set<string> {
	return new Set(BANNED_MODELS.filter((entry) => entry.provider === provider).map((entry) => entry.id));
}

/** Read a provider's full catalogue from the cached model store. */
function readCachedModels(provider: string): AnyModel[] {
	try {
		const store = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "models-store.json"), "utf-8")) as Record<
			string,
			{ models?: AnyModel[] }
		>;
		return store[provider]?.models ?? [];
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

export default function (pi: ExtensionAPI) {
	/** Full catalogues captured before they are filtered, keyed by provider. */
	const base = new Map<string, AnyModel[]>();

	function apply(ctx?: ExtensionContext): void {
		for (const provider of new Set(BANNED_MODELS.map((entry) => entry.provider))) {
			let models = base.get(provider);
			if (!models || models.length === 0) {
				models =
					ctx?.modelRegistry.getAll().filter((model) => model.provider === provider) ?? readCachedModels(provider);
				if (models.length === 0) models = readCachedModels(provider);
				base.set(provider, models);
			}
			const banned = bannedIdsFor(provider);
			const kept = models.filter((model) => !banned.has(model.id));
			pi.registerProvider(provider, { models: kept.map(toProviderModel) as never });
		}
	}

	// Apply at load (from the cached catalogue), then again on each session boundary.
	apply();

	pi.on("session_start", (_event, ctx) => {
		apply(ctx);
		const selected = ctx.model;
		if (!selected) return;
		if (!bannedIdsFor(selected.provider).has(selected.id)) return;
		const fallback = ctx.modelRegistry.find(FALLBACK.provider, FALLBACK.id);
		if (fallback) void pi.setModel(fallback);
		if (ctx.hasUI) ctx.ui.notify(`${selected.provider}/${selected.id} is banned; switched to a fallback model.`, "warning");
	});

	// Defence in depth: catch a selection that still names a banned model.
	pi.on("model_select", async (event, ctx) => {
		if (!bannedIdsFor(event.model.provider).has(event.model.id)) return;
		const fallback = ctx.modelRegistry.find(FALLBACK.provider, FALLBACK.id);
		const switched = fallback ? await pi.setModel(fallback) : false;
		if (ctx.hasUI) {
			ctx.ui.notify(
				switched
					? `${event.model.provider}/${event.model.id} is banned; switched to ${FALLBACK.provider}/${FALLBACK.id}.`
					: `${event.model.provider}/${event.model.id} is banned. Select another model.`,
				"warning",
			);
		}
	});
}
