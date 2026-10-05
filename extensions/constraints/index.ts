/**
 * constraints - cross-process guardrail against burst API usage.
 *
 * Why this exists: a burst of provider requests (for example, probing many models with repeated
 * `pi --model ... -p` runs) can trip account-level rate limits that also affect other clients
 * sharing the same account (Codex, the ChatGPT app, ...).
 *
 * Each `pi` process is separate, so in-memory throttling cannot see the burst. This extension
 * keeps a shared sliding window in `<agent-dir>/constraints-state.json` and delays a provider
 * request until the shared budget allows it. It is a delay, never a drop: a session cannot be
 * broken by it.
 *
 * Budget (see `<agent-dir>/constraints.json`, optional):
 *   { "enabled": true, "windowMs": 20000, "maxRequests": 12, "minIntervalMs": 800 }
 *
 * - At most `maxRequests` provider requests across all pi processes per `windowMs`.
 * - At least `minIntervalMs` between two consecutive provider requests.
 *
 * `/constraints` shows the current budget and usage; `/constraints off|on` toggles it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = path.join(getAgentDir(), "constraints.json");
const STATE_PATH = path.join(getAgentDir(), "constraints-state.json");

interface ConstraintsConfig {
	enabled: boolean;
	windowMs: number;
	maxRequests: number;
	minIntervalMs: number;
}

const DEFAULTS: ConstraintsConfig = { enabled: true, windowMs: 20_000, maxRequests: 12, minIntervalMs: 800 };

function loadConfig(): ConstraintsConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Partial<ConstraintsConfig>;
		return {
			enabled: raw.enabled !== false,
			windowMs: typeof raw.windowMs === "number" ? raw.windowMs : DEFAULTS.windowMs,
			maxRequests: typeof raw.maxRequests === "number" ? raw.maxRequests : DEFAULTS.maxRequests,
			minIntervalMs: typeof raw.minIntervalMs === "number" ? raw.minIntervalMs : DEFAULTS.minIntervalMs,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

function saveConfig(config: ConstraintsConfig): void {
	fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function readState(now: number, windowMs: number): number[] {
	try {
		const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as { requests?: number[] };
		return (raw.requests ?? []).filter((t) => typeof t === "number" && now - t < windowMs);
	} catch {
		return [];
	}
}

function writeState(requests: number[]): void {
	try {
		fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
		fs.writeFileSync(STATE_PATH, `${JSON.stringify({ requests })}\n`, "utf-8");
	} catch {
		// Best effort: losing the shared window must never break a session.
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default function (pi: ExtensionAPI) {
	/** Avoid spamming the notice while throttled. */
	let lastNotice = 0;

	/** Wait until the shared budget allows one more provider request, then record it. */
	async function acquire(ctx: ExtensionContext): Promise<void> {
		const config = loadConfig();
		if (!config.enabled) return;

		for (;;) {
			const now = Date.now();
			const requests = readState(now, config.windowMs);

			let waitMs = 0;
			const last = requests.length > 0 ? Math.max(...requests) : 0;
			if (last > 0 && now - last < config.minIntervalMs) {
				waitMs = Math.max(waitMs, config.minIntervalMs - (now - last));
			}
			if (requests.length >= config.maxRequests) {
				const oldest = Math.min(...requests);
				waitMs = Math.max(waitMs, oldest + config.windowMs - now + 50);
			}

			if (waitMs <= 0) {
				requests.push(now);
				writeState(requests);
				return;
			}

			if (ctx.hasUI && now - lastNotice > 10_000) {
				lastNotice = now;
				ctx.ui.notify(
					`constraints: delaying a provider request ~${Math.ceil(waitMs / 1000)}s to avoid a burst ` +
						`(limit ${config.maxRequests}/${Math.round(config.windowMs / 1000)}s across all pi processes).`,
					"warning",
				);
			}
			await sleep(Math.min(waitMs, 5_000));
		}
	}

	// Fired before every provider HTTP request, in every pi process (including `-p` and subagents).
	pi.on("before_provider_request", async (_event, ctx) => {
		await acquire(ctx);
	});

	pi.registerCommand("constraints", {
		description: "Show or toggle the cross-process provider rate limit",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			const config = loadConfig();

			if (action === "off" || action === "on") {
				config.enabled = action === "on";
				saveConfig(config);
			} else if (action && action !== "status") {
				ctx.ui.notify("Usage: /constraints [status|on|off]", "warning");
				return;
			}

			const effective = loadConfig();
			const now = Date.now();
			const used = effective.enabled ? readState(now, effective.windowMs).length : 0;
			ctx.ui.notify(
				`constraints: ${effective.enabled ? "on" : "off"} · ${used}/${effective.maxRequests} requests in the last ` +
					`${Math.round(effective.windowMs / 1000)}s · min interval ${effective.minIntervalMs}ms\nconfig: ${CONFIG_PATH}`,
				"info",
			);
		},
	});
}
