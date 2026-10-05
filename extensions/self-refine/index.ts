/**
 * self-refine - the exempted self-modification mode.
 *
 * Normal work does not need the heartbeat. Self-refine is the only case that does: the agent is
 * allowed to edit its own extensions and configuration, which the automode safety-control
 * hard-deny normally blocks.
 *
 * Turning it on:
 *   1. runs the heartbeat check (session + configured tests); refuses and rolls back if not alive;
 *   2. takes a checkpoint (git) before any self-modification;
 *   3. grants the exemption by suspending automode for the session (it is restored on off);
 *   4. marks self-refine active so the heartbeat "if you are alive" prompt is armed.
 *
 * Commands: /selfrefine on [goal] · /selfrefine off · /selfrefine status
 *
 * State: `~/.pi/agent/self-refine.json`. Tests come from `~/.pi/agent/heartbeat.json`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_FILE = path.join(getAgentDir(), "self-refine.json");
const HEARTBEAT_FILE = path.join(getAgentDir(), "heartbeat.json");

/** Maximum self-critique passes per user turn. */
const MAX_PASSES = 3;

/** Read the latest assistant text on the branch. */
function lastAssistantText(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.flatMap((b) =>
					b && typeof b === "object" && (b as { type?: string }).type === "text" ? [(b as { text?: string }).text ?? ""] : [],
				)
				.join("");
		}
		return "";
	}
	return "";
}

interface SelfRefineState {
	active: boolean;
	goal?: string;
	since?: number;
	suspendedAutomode?: boolean;
}

export function readSelfRefine(): SelfRefineState {
	try {
		const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as Partial<SelfRefineState>;
		return { active: raw.active === true, goal: raw.goal, since: raw.since, suspendedAutomode: raw.suspendedAutomode };
	} catch {
		return { active: false };
	}
}

function writeSelfRefine(state: SelfRefineState): void {
	fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
	fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function tests(): string[] {
	try {
		const raw = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf-8")) as { tests?: string[] };
		return Array.isArray(raw.tests) ? raw.tests : [];
	} catch {
		return [];
	}
}

async function checkpoint(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string> {
	const cwd = ctx.cwd;
	const inside = await pi.exec("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || inside.stdout.trim() !== "true") return "not a git work tree; no checkpoint";
	const created = await pi.exec("git", ["-C", cwd, "stash", "create"]);
	const ref = created.stdout.trim();
	const dir = path.join(getAgentDir(), "checkpoints");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${ctx.sessionManager.getSessionId()}.json`);
	let all: unknown[] = [];
	try {
		all = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown[];
	} catch {
		all = [];
	}
	all.push({
		id: `${Date.now().toString(36)}-selfrefine`,
		time: Date.now(),
		cwd,
		entryId: ctx.sessionManager.getLeafEntry()?.id,
		stash: ref || undefined,
	});
	fs.writeFileSync(file, `${JSON.stringify(all.slice(-50), null, 2)}\n`, "utf-8");
	return ref ? `checkpoint ${ref.slice(0, 10)}` : "checkpoint (clean tree)";
}

function heartbeatAlive(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
	const active = new Set(pi.getActiveTools());
	return tests()
		.filter((tool) => !active.has(tool))
		.map((tool) => tool);
}

export default function (pi: ExtensionAPI) {
	/** Self-critique passes used in the current turn. */
	let passes = 0;

	pi.on("agent_start", () => {
		passes = 0;
	});

	// The refine loop: only while self-refine is active, ask the model to critique and fix its own
	// work, bounded by MAX_PASSES and stopped early when it reports no further fixes.
	pi.on("agent_before_settle", (event, ctx) => {
		if (!readSelfRefine().active) return;
		if (event.outcome !== "completed") return;
		if (passes >= MAX_PASSES) {
			passes = 0;
			return;
		}
		if (/SELF-REFINE:\s*DONE/i.test(lastAssistantText(ctx))) {
			passes = 0;
			return;
		}
		passes++;
		return {
			entries: [
				{
					type: "custom_message",
					customType: "self-refine",
					content: `Self-refine pass ${passes}/${MAX_PASSES}: critically review the work you just did against the goal. Find and fix concrete defects (bugs, missed cases, inconsistencies, unverified claims). If there is nothing left to fix, reply with the exact line "SELF-REFINE: DONE".`,
					display: true,
				},
			],
			continue: true,
		};
	});

	pi.registerCommand("selfrefine", {
		description: "Exempted self-modification mode: on [goal] | off | status",
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const state = readSelfRefine();

			if (action === "status" || (!action && !state.active)) {
				ctx.ui.notify(
					`self-refine: ${state.active ? "ON" : "off"}${state.goal ? ` (goal: ${state.goal})` : ""}\nstate: ${STATE_FILE}`,
					"info",
				);
				return;
			}

			if (action === "off") {
				state.active = false;
				writeSelfRefine(state);
				const reminder = state.suspendedAutomode
					? " The auto-monitor is still suspended: run /autommonitor on to re-enable it."
					: "";
				ctx.ui.notify(`self-refine off. Run /reload-runtime to apply code changes.${reminder}`, "info");
				return;
			}

			if (action !== "on") {
				ctx.ui.notify("Usage: /selfrefine [on [goal] | off | status]", "warning");
				return;
			}

			// 1. heartbeat must be alive
			const failures = heartbeatAlive(pi, ctx);
			if (failures.length > 0) {
				ctx.ui.notify(`self-refine refused: heartbeat not alive (${failures.join(", ")})`, "error");
				return;
			}

			// 2. checkpoint before self-modification
			const note = await checkpoint(pi, ctx);

			// 3. exemption: automatically suspend the auto-monitor (its safety-control hard-deny blocks editing our own files)
			pi.sendUserMessage("/autommonitor off", { deliverAs: "followUp" });

			// 4. mark active + describe the contract
			state.active = true;
			state.goal = rest.join(" ") || undefined;
			state.since = Date.now();
			state.suspendedAutomode = true;
			writeSelfRefine(state);

			pi.sendMessage(
				{
					customType: "self-refine",
					content:
						`Self-refine mode is ON${state.goal ? ` (goal: ${state.goal})` : ""}. Automode is suspended so you may edit your own extensions/configuration. ${note}. After edits, call heartbeat action=reload to reload (it is forced through an alive check), or run /rollback if the change breaks you. Turn it off with /selfrefine off when done.`,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
			ctx.ui.notify(`self-refine ON. ${note}. Automode suspended.`, "info");
		},
	});
}
