/**
 * goal — keep the session working until a completion condition holds (Claude Code-style `/goal`).
 *
 *   /goal <condition>            set the condition; the session keeps running until it holds
 *   /goal                        show status (condition, running time, turns, last reason)
 *   /goal clear|stop|off|reset|none|cancel   clear the goal
 *
 * After every completed turn an **independent** pi process (a separate model, `PI_GOAL_MODEL`,
 * default `deepseek/deepseek-flash`) judges the condition against the conversation and returns
 * met / not-met / impossible with a reason. not-met starts another turn with the reason as
 * guidance; met/impossible clears the goal.
 *
 * State is **durable in the session**: the goal is stored as a `custom` session entry
 * (`appendEntry("goal", …)`), so it resumes with the session and needs no side files. The condition
 * is restored on `session_start` with the turn count/timer reset, like Claude Code.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const EVALUATOR_MODEL = process.env.PI_GOAL_MODEL ?? "deepseek/deepseek-flash";
/** Hard stop so a goal can never loop forever without a human. */
const MAX_VERDICTS = 25;

type GoalState = {
	active: boolean;
	condition?: string;
	since?: number;
	verdicts: number;
	lastReason?: string;
	outcome?: "achieved" | "impossible" | "cleared";
	at?: number;
};

type Verdict = { verdict: "met" | "not-met" | "impossible"; reason: string };

/** The latest goal state recorded in the session, if any. */
function readGoal(ctx: ExtensionContext | { sessionManager: ExtensionContext["sessionManager"] }): GoalState {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== "goal") continue;
		const data = (entry as { data?: Partial<GoalState> }).data;
		if (data === undefined) continue;
		return {
			active: data.active === true,
			condition: data.condition,
			since: data.since,
			verdicts: data.verdicts ?? 0,
			lastReason: data.lastReason,
			outcome: data.outcome,
			at: data.at,
		};
	}
	return { active: false, verdicts: 0 };
}

/** Append the goal state as a durable session entry. */
function writeGoal(pi: ExtensionAPI, state: GoalState): void {
	pi.appendEntry("goal", state);
}

function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

/** A bounded plain-text view of the recent conversation for the evaluator. */
function recentTranscript(ctx: ExtensionContext, maxChars = 8000): string {
	const lines: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		const role = message.role ?? "?";
		let text = "";
		if (typeof message.content === "string") text = message.content;
		else if (Array.isArray(message.content)) {
			text = message.content
				.flatMap((b) => {
					if (!b || typeof b !== "object") return [];
					const block = b as { type?: string; text?: string; name?: string };
					if (block.type === "text") return [block.text ?? ""];
					if (block.type === "toolCall") return [`[tool ${block.name ?? "?"}]`];
					return [];
				})
				.join(" ");
		}
		if (text.trim().length === 0) continue;
		lines.push(`${role}: ${text}`);
	}
	const joined = lines.join("\n");
	return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	// Prefer the installed `pi` launcher: it sets up the source resolver and provider auth.
	const launcher = path.join(getAgentDir(), "bin", "pi");
	if (fs.existsSync(launcher)) return { command: launcher, args };
	return { command: "pi", args };
}

/** The final assistant text from `--mode json` output (ignores system/user messages). */
function extractText(output: string): string {
	let last = "";
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const event = JSON.parse(trimmed) as { message?: { role?: string; content?: unknown } };
			if (event.message?.role !== "assistant") continue;
			const content = event.message.content;
			if (!Array.isArray(content)) continue;
			const text = content
				.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
				.map((block) => (block as { text?: string }).text ?? "")
				.join("");
			if (text.trim().length > 0) last = text;
		} catch {
			// not a complete JSON line
		}
	}
	return last;
}

/** Ask an independent model whether the condition holds. */
async function evaluate(condition: string, transcript: string, signal?: AbortSignal): Promise<Verdict> {
	const prompt = [
		"You are a strict goal evaluator. Decide whether the completion condition is satisfied.",
		"The conversation below is the ONLY evidence; you cannot run tools or read files.",
		"",
		`Condition: ${condition}`,
		"",
		"Conversation:",
		transcript,
		"",
		'Reply with exactly one JSON object: {"verdict":"met"|"not-met"|"impossible","reason":"<short reason>"}.',
		"met = the condition demonstrably holds. impossible = it can never be satisfied as stated.",
	].join("\n");
	const invocation = piInvocation([
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-tools",
		"--model",
		EVALUATOR_MODEL,
		prompt,
	]);
	return await new Promise<Verdict>((resolve) => {
		let settled = false;
		const done = (verdict: Verdict): void => {
			if (settled) return;
			settled = true;
			resolve(verdict);
		};
		const child = spawn(invocation.command, invocation.args, {
			stdio: ["ignore", "pipe", "pipe"],
			...(signal === undefined ? {} : { signal }),
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		child.on("error", () => done({ verdict: "not-met", reason: "evaluator failed to start" }));
		child.on("close", () => {
			const text = extractText(out);
			const match = /\{[\s\S]*\}/.exec(text);
			if (match) {
				try {
					const parsed = JSON.parse(match[0]) as { verdict?: string; reason?: string };
					const verdict = parsed.verdict === "met" ? "met" : parsed.verdict === "impossible" ? "impossible" : "not-met";
					return done({ verdict, reason: parsed.reason ?? "" });
				} catch {
					// fall through
				}
			}
			done({ verdict: "not-met", reason: text.slice(0, 200) || "no verdict returned" });
		});
	});
}

function statusText(state: GoalState): string {
	if (state.active && state.condition !== undefined) {
		const running = state.since === undefined ? "" : ` · running ${formatDuration(Date.now() - state.since)}`;
		const last = state.lastReason === undefined ? "" : `\nlast: ${state.lastReason}`;
		return `◎ /goal active · turns ${state.verdicts}/${MAX_VERDICTS}${running}\ncondition: ${state.condition}${last}`;
	}
	if (state.outcome !== undefined && state.condition !== undefined) {
		const spent = state.at === undefined || state.since === undefined ? "" : ` (${formatDuration(state.at - state.since)})`;
		return `${state.outcome === "achieved" ? "✔" : "✖"} goal ${state.outcome}: ${state.condition}${spent}`;
	}
	return "No goal set";
}

export default function (pi: ExtensionAPI) {
	// Restore an active goal on every resume route; carry the condition over, reset counters.
	pi.on("session_start", (_event, ctx) => {
		const state = readGoal(ctx);
		if (!state.active || state.condition === undefined) return;
		writeGoal(pi, { active: true, condition: state.condition, since: Date.now(), verdicts: 0 });
		if (ctx.hasUI) ctx.ui.setStatus("goal", `◎ goal: ${state.condition}`);
		ctx.ui.notify(`◎ goal restored — ${state.condition}`, "info");
	});

	// After every completed turn, have an independent model judge the condition.
	pi.on("agent_before_settle", async (event, ctx) => {
		const state = readGoal(ctx);
		if (!state.active || state.condition === undefined) return;
		if (event.outcome !== "completed") return;
		if (state.verdicts >= MAX_VERDICTS) {
			writeGoal(pi, { ...state, active: false, outcome: "cleared", at: Date.now() });
			if (ctx.hasUI) ctx.ui.setStatus("goal", undefined);
			ctx.ui.notify(`goal: paused after ${MAX_VERDICTS} turns without a met verdict`, "warning");
			return;
		}

		const verdict = await evaluate(state.condition, recentTranscript(ctx), event.signal);

		if (verdict.verdict === "met" || verdict.verdict === "impossible") {
			writeGoal(pi, {
				active: false,
				condition: state.condition,
				since: state.since,
				verdicts: state.verdicts,
				lastReason: verdict.reason,
				outcome: verdict.verdict === "met" ? "achieved" : "impossible",
				at: Date.now(),
			});
			if (ctx.hasUI) ctx.ui.setStatus("goal", undefined);
			ctx.ui.notify(
				verdict.verdict === "met" ? `◎ goal met — ${verdict.reason}` : `goal impossible — ${verdict.reason}`,
				verdict.verdict === "met" ? "info" : "warning",
			);
			return;
		}

		const next: GoalState = { ...state, verdicts: state.verdicts + 1, lastReason: verdict.reason };
		writeGoal(pi, next);
		if (ctx.hasUI) ctx.ui.setStatus("goal", `◎ goal (turn ${next.verdicts}): ${state.condition}`);
		return {
			entries: [
				{
					type: "custom_message",
					customType: "goal",
					content: `Goal not yet met: ${verdict.reason}\nKeep working toward: ${state.condition}\nIf it is genuinely impossible, reply with the exact line "GOAL: IMPOSSIBLE".`,
					display: true,
				},
			],
			continue: true,
		};
	});

	// Let the agent itself raise a goal in the main loop; completion is judged independently.
	pi.registerTool({
		name: "goal",
		label: "Goal",
		description: [
			"Set, inspect, or clear a completion goal for this session.",
			"While a goal is active an independent model judges after every turn whether the condition holds;",
			"if it is not yet met it starts another turn with the reason, and it clears the goal when met or impossible.",
			"Use it for substantial work with a verifiable end state. Never self-declare completion.",
		].join(" "),
		parameters: Type.Object({
			action: Type.Union([Type.Literal("set"), Type.Literal("status"), Type.Literal("clear")]),
			condition: Type.Optional(Type.String({ description: "Completion condition (required for action=set)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "status") {
				return { content: [{ type: "text", text: statusText(readGoal(ctx)) }], details: {} };
			}
			if (params.action === "clear") {
				const state = readGoal(ctx);
				if (state.active) {
					writeGoal(pi, { ...state, active: false, outcome: "cleared", at: Date.now() });
					if (ctx.hasUI) ctx.ui.setStatus("goal", undefined);
				}
				return {
					content: [{ type: "text", text: state.active ? `Goal cleared: ${state.condition}` : "No goal set" }],
					details: {},
				};
			}
			const condition = (params.condition ?? "").trim();
			if (condition.length === 0) {
				return { content: [{ type: "text", text: "action=set requires a non-empty condition" }], details: {} };
			}
			writeGoal(pi, { active: true, condition, since: Date.now(), verdicts: 0 });
			if (ctx.hasUI) ctx.ui.setStatus("goal", `◎ goal: ${condition}`);
			return {
				content: [
					{
						type: "text",
						text: `Goal set: ${condition}\nAn independent evaluator judges it after each turn — keep working and do not declare completion yourself.`,
					},
				],
				details: {},
			};
		},
	});

	pi.registerCommand("goal", {
		description: "Keep working until a condition holds: /goal <condition> | /goal | /goal clear",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			const state = readGoal(ctx);
			const clearAliases = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

			if (clearAliases.has(text.toLowerCase())) {
				if (!state.active) {
					ctx.ui.notify("No goal set", "info");
					return;
				}
				writeGoal(pi, { ...state, active: false, outcome: "cleared", at: Date.now() });
				if (ctx.hasUI) ctx.ui.setStatus("goal", undefined);
				ctx.ui.notify(`Goal cleared: ${state.condition}`, "info");
				return;
			}
			if (text.length === 0) {
				ctx.ui.notify(statusText(state), "info");
				return;
			}
			writeGoal(pi, { active: true, condition: text, since: Date.now(), verdicts: 0 });
			if (ctx.hasUI) ctx.ui.setStatus("goal", `◎ goal: ${text}`);
			ctx.ui.notify(`◎ goal set — ${text}`, "info");
			// Setting a goal starts a turn immediately, with the condition as the directive.
			pi.sendUserMessage(text);
		},
	});
}
