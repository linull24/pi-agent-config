/**
 * heartbeat - the single resilience mechanism: checkpoints, liveness, guarded reload, rollback.
 *
 * Heartbeat is a mechanism, not just a tool. Everything goes through it:
 *
 *   heartbeat({ action: "alive" })     - "I am alive": verify session + configured tests.
 *   heartbeat({ action: "settest", tests: [...] }) - set what "alive" verifies.
 *   heartbeat({ action: "reload", reason })        - reload, forced through a heartbeat first.
 *   heartbeat({ action: "rollback", ref? })        - restore the last usable checkpoint.
 *
 * Rules:
 * - A silent git checkpoint is taken at every turn start (git work trees only).
 * - A reload is refused unless the heartbeat is alive; if not alive it rolls back instead.
 * - On (re)start (session_start reason "startup"|"reload") the plugin messages the agent:
 *   "if you are alive, call heartbeat action=alive". Work is not retained until that arrives.
 * - `/rollback` (user command) also restores the last checkpoint.
 *
 * State: `~/.pi/agent/heartbeat.json` and `~/.pi/agent/checkpoints/<sessionId>.json`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DIR = path.join(getAgentDir(), "checkpoints");
const STATE_FILE = path.join(getAgentDir(), "heartbeat.json");
const MAX_CHECKPOINTS = 50;

interface Checkpoint {
	id: string;
	time: number;
	cwd: string;
	entryId?: string;
	head?: string;
	stash?: string;
}

interface HeartbeatState {
	/** Default tools to verify on `alive`. */
	tests: string[];
	/** Per-session state. */
	sessions: Record<string, { aliveAt?: number; pendingSince?: number; reloadPending?: boolean }>;
}

function readState(): HeartbeatState {
	try {
		const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as Partial<HeartbeatState>;
		return { tests: Array.isArray(raw.tests) ? raw.tests : [], sessions: raw.sessions ?? {} };
	} catch {
		return { tests: [], sessions: {} };
	}
}

function writeState(state: HeartbeatState): void {
	fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
	fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function sessionState(state: HeartbeatState, id: string): NonNullable<HeartbeatState["sessions"][string]> {
	state.sessions[id] ??= {};
	return state.sessions[id];
}

function checkpointFile(ctx: ExtensionContext): string {
	return path.join(DIR, `${ctx.sessionManager.getSessionId()}.json`);
}

function loadCheckpoints(ctx: ExtensionContext): Checkpoint[] {
	try {
		return JSON.parse(fs.readFileSync(checkpointFile(ctx), "utf-8")) as Checkpoint[];
	} catch {
		return [];
	}
}

function saveCheckpoints(ctx: ExtensionContext, checkpoints: Checkpoint[]): void {
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFileSync(checkpointFile(ctx), `${JSON.stringify(checkpoints.slice(-MAX_CHECKPOINTS), null, 2)}\n`, "utf-8");
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", ["-C", cwd, ...args]);
	return result.code === 0 ? result.stdout.trim() : "";
}

async function createCheckpoint(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const cwd = ctx.cwd;
	if ((await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") return;
	const stash = await git(pi, cwd, ["stash", "create"]);
	const head = await git(pi, cwd, ["rev-parse", "HEAD"]);
	const all = loadCheckpoints(ctx);
	all.push({
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		time: Date.now(),
		cwd,
		entryId: ctx.sessionManager.getLeafEntry()?.id,
		head: head || undefined,
		stash: stash || undefined,
	});
	saveCheckpoints(ctx, all);
}

async function restore(pi: ExtensionAPI, checkpoint: Checkpoint | undefined): Promise<string> {
	if (!checkpoint) return "no checkpoint to restore";
	if (!checkpoint.stash) return `checkpoint ${checkpoint.id}: no working-tree changes to restore`;
	const result = await pi.exec("git", ["-C", checkpoint.cwd, "stash", "apply", checkpoint.stash]);
	return result.code === 0
		? `checkpoint ${checkpoint.id}: working tree restored`
		: `checkpoint ${checkpoint.id}: restore failed - ${result.stderr.trim() || result.stdout.trim()}`;
}

function pick(checkpoints: Checkpoint[], ref?: string): Checkpoint | undefined {
	if (checkpoints.length === 0) return undefined;
	if (!ref) return checkpoints[checkpoints.length - 1];
	const index = Number(ref);
	if (Number.isInteger(index) && index >= 0 && index < checkpoints.length) return checkpoints[index];
	return checkpoints.find((c) => c.id === ref || c.id.startsWith(ref));
}

/** Run the liveness checks and return the failures. */
function runChecks(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	tests: string[],
): Array<{ name: string; ok: boolean; detail: string }> {
	const active = new Set(pi.getActiveTools());
	const checks = [{ name: "session", ok: true, detail: ctx.isIdle() ? "idle" : "streaming" }];
	for (const tool of tests) {
		checks.push({ name: tool, ok: active.has(tool), detail: active.has(tool) ? "available" : "NOT AVAILABLE" });
	}
	return checks.filter((c) => !c.ok);
}

export default function (pi: ExtensionAPI) {
	pi.on("turn_start", async (_event, ctx) => {
		try {
			await createCheckpoint(pi, ctx);
		} catch {
			// checkpointing must never disturb a turn
		}
	});

	// After (re)start, ask the agent to confirm it is alive. Heartbeat is only armed during
	// self-refine; outside that mode it is off (it exists for editing our own safety controls).
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "reload") return;
		if (!ctx.hasUI) return;
		let selfRefine = false;
		try {
			selfRefine =
				(JSON.parse(fs.readFileSync(path.join(getAgentDir(), "self-refine.json"), "utf-8")) as { active?: boolean }).active === true;
		} catch {
			selfRefine = false;
		}
		if (!selfRefine) return;
		const state = readState();
		sessionState(state, ctx.sessionManager.getSessionId()).pendingSince = Date.now();
		writeState(state);
		pi.sendMessage(
			{
				customType: "heartbeat",
				content:
					'Heartbeat required: the runtime just (re)started. If you are alive, call the `heartbeat` tool with action "alive" to confirm (it checks the session and your configured tests). Until you confirm, this run is not retained.',
				display: true,
			},
			{ deliverAs: "nextTurn" },
		);
	});

	pi.registerTool({
		name: "heartbeat",
		label: "Heartbeat",
		description:
			"The single resilience entry. action=alive confirms you are alive and checks the session and configured tools (rolls back on failure); action=settest sets what alive verifies; action=reload reloads the runtime, forced through an alive check first; action=rollback restores the last checkpoint.",
		parameters: Type.Object({
			action: StringEnum(["alive", "settest", "reload", "rollback"], { description: "What to do", default: "alive" }),
			tests: Type.Optional(Type.Array(Type.String(), { description: "Tool names for settest/alive" })),
			ref: Type.Optional(Type.String({ description: "Checkpoint id or index for rollback" })),
			reason: Type.Optional(Type.String({ description: "Why a reload is needed" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = readState();
			const sessionId = ctx.sessionManager.getSessionId();
			const session = sessionState(state, sessionId);

			if (params.action === "settest") {
				state.tests = params.tests ?? [];
				writeState(state);
				return {
					content: [{ type: "text", text: `heartbeat tests set: ${state.tests.join(", ") || "(none)"}` }],
					details: { tests: state.tests },
				};
			}

			if (params.action === "rollback") {
				const message = await restore(pi, pick(loadCheckpoints(ctx), params.ref));
				return { content: [{ type: "text", text: message }], details: {} };
			}

			const tests = params.tests ?? state.tests;
			const failures = runChecks(pi, ctx, tests);
			const alive = failures.length === 0;

			if (params.action === "alive") {
				if (alive) {
					session.aliveAt = Date.now();
					session.pendingSince = undefined;
					writeState(state);
					return { content: [{ type: "text", text: "heartbeat: alive" }], details: { alive: true, tests } };
				}
				const message = await restore(pi, pick(loadCheckpoints(ctx)));
				return {
					content: [{ type: "text", text: `heartbeat: FAILED - ${failures.map((f) => f.name).join(", ")}\n${message}` }],
					details: { alive: false, failures, rolledBack: message },
				};
			}

			// action === "reload": forced through the heartbeat.
			if (!alive) {
				const message = await restore(pi, pick(loadCheckpoints(ctx)));
				return {
					content: [
						{
							type: "text",
							text: `reload refused: heartbeat is not alive (${failures.map((f) => f.name).join(", ")}). Rolled back.\n${message}`,
						},
					],
					details: { alive: false, reloaded: false, rolledBack: message },
				};
			}
			session.aliveAt = Date.now();
			session.reloadPending = true;
			writeState(state);
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Reload runtime?",
					`Heartbeat is alive.${params.reason ? `\n${params.reason}` : ""}\n\nConfirm to reload. Cancel and run /rollback to undo instead.`,
				);
				if (!ok) {
					return {
						content: [
							{ type: "text", text: "Reload canceled (heartbeat alive). Run /rollback to restore the last checkpoint if needed." },
						],
						details: { alive: true, reloaded: false },
					};
				}
			}
			pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: "Reload confirmed; queued /reload-runtime as a follow-up." }],
				details: { alive: true, reloaded: true },
			};
		},
	});

	pi.registerCommand("heartbeat", {
		description: "Heartbeat mechanism: alive | settest | reload | rollback",
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const state = readState();
			if (action === "settest") {
				state.tests = rest;
				writeState(state);
				ctx.ui.notify(`heartbeat tests set: ${rest.join(", ") || "(none)"}`, "info");
				return;
			}
			if (action === "rollback") {
				ctx.ui.notify(await restore(pi, pick(loadCheckpoints(ctx), rest[0])), "info");
				return;
			}
			if (action === "alive") {
				const failures = runChecks(pi, ctx, state.tests);
				ctx.ui.notify(
					failures.length === 0 ? "heartbeat: alive" : `heartbeat: FAILED - ${failures.map((f) => f.name).join(", ")}`,
					failures.length === 0 ? "info" : "error",
				);
				return;
			}
			ctx.ui.notify("Usage: /heartbeat [alive|settest <tools...>|rollback [ref]]", "info");
		},
	});

	pi.registerCommand("rollback", {
		description: "Restore the working tree to the last checkpoint (or /rollback <id|index>)",
		handler: async (args, ctx) => {
			const message = await restore(pi, pick(loadCheckpoints(ctx), args.trim() || undefined));
			ctx.ui.notify(message, message.includes("failed") ? "error" : "info");
		},
	});

	pi.registerCommand("checkpoints", {
		description: "List checkpoints for the current session",
		handler: async (_args, ctx) => {
			const checkpoints = loadCheckpoints(ctx);
			if (checkpoints.length === 0) {
				ctx.ui.notify("no checkpoints for this session", "info");
				return;
			}
			const lines = checkpoints.map(
				(c, i) => `${i}  ${c.id}  ${new Date(c.time).toLocaleTimeString()}  ${c.stash ? "stash" : "clean"}`,
			);
			ctx.ui.notify(`checkpoints:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});
}
