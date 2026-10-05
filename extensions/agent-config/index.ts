/**
 * agent-config - apply the central role registry (`~/.pi/agent/agent-config.json`) everywhere.
 *
 * Edit one file. At each session start this extension:
 *   - writes `classifier` -> `~/.pi/agent/extensions/pi-automode/config.json` (`autoMode.classifierModel`);
 *   - writes `supervisor` -> `<cwd>/.pi/supervisor-config.json` (`model`), and, when the role has a
 *     `prompt`, generates `~/.pi/agent/SUPERVISOR.md`;
 *   - generates `~/.pi/agent/agents/<role>.md` for every role with an `agent` block, from the
 *     role's model and its prompt file under `~/.pi/agent/roles/`.
 *
 * The `router` extension reads `daily` / `research` / `failover` from the same file.
 *
 * `/agent-config` shows every role and what it resolved to.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENTS_DIR, CONFIG_PATH, loadConfig, parseSpec, readPrompt, resolveModel, type RoleSpec } from "../_shared/roles.ts";

const AUTOMODE_CONFIG = path.join(getAgentDir(), "extensions", "pi-automode", "config.json");
const SUPERVISOR_PROMPT = path.join(getAgentDir(), "SUPERVISOR.md");
const SETTINGS = path.join(getAgentDir(), "settings.json");
const CRON_JOBS = path.join(getAgentDir(), "cron", "jobs.json");

function readJson(file: string): Record<string, unknown> {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function writeIfChanged(file: string, content: string): boolean {
	try {
		if (fs.readFileSync(file, "utf-8") === content) return false;
	} catch {
		// missing file
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
	return true;
}

function writeJsonIfChanged(file: string, data: unknown): boolean {
	return writeIfChanged(file, `${JSON.stringify(data, null, 2)}\n`);
}

function renderAgent(name: string, role: RoleSpec, spec: string): string {
	const front = ["---", `name: ${name}`, `description: ${role.agent?.description ?? name}`];
	if (role.agent?.tools && role.agent.tools.length > 0) front.push(`tools: ${role.agent.tools.join(", ")}`);
	front.push(`model: ${spec}`, "---");
	const body = readPrompt(role.prompt) ?? "";
	return `${front.join("\n")}\n\n${body}\n`;
}

export default function (pi: ExtensionAPI) {
	function sync(ctx: ExtensionContext): string[] {
		const config = loadConfig();
		const roles = config.roles;
		const wrote: string[] = [];

		// session -> settings.json default model
		const session = parseSpec(roles.session?.model?.[0] ?? "");
		if (session) {
			const settings = readJson(SETTINGS);
			if (settings.defaultProvider !== session.provider || settings.defaultModel !== session.id) {
				settings.defaultProvider = session.provider;
				settings.defaultModel = session.id;
				if (writeJsonIfChanged(SETTINGS, settings)) wrote.push("settings.defaultModel");
			}
		}

		// classifier -> pi-automode
		const classifier = resolveModel(ctx, roles.classifier?.model);
		if (classifier) {
			const config = readJson(AUTOMODE_CONFIG);
			const autoMode = (config.autoMode ?? {}) as Record<string, unknown>;
			if (autoMode.classifierModel !== classifier.spec) {
				config.autoMode = { ...autoMode, classifierModel: classifier.spec };
				if (writeJsonIfChanged(AUTOMODE_CONFIG, config)) wrote.push("automode.classifier");
			}
		}

		// supervisor -> <cwd>/.pi/supervisor-config.json and optional SUPERVISOR.md
		const supervisor = resolveModel(ctx, roles.supervisor?.model);
		if (supervisor) {
			const file = path.join(ctx.cwd, ".pi", "supervisor-config.json");
			const config = readJson(file);
			const model = { provider: supervisor.provider, modelId: supervisor.id };
			const current = config.model as { provider?: string; modelId?: string } | undefined;
			if (current?.provider !== model.provider || current?.modelId !== model.modelId) {
				config.model = model;
				if (writeJsonIfChanged(file, config)) wrote.push("supervisor.model");
			}
		}
		const supervisorPrompt = readPrompt(roles.supervisor?.prompt);
		if (supervisorPrompt && writeIfChanged(SUPERVISOR_PROMPT, `${supervisorPrompt}\n`)) {
			wrote.push("SUPERVISOR.md");
		}

		// every role with an `agent` block -> ~/.pi/agent/agents/<role>.md
		for (const [name, role] of Object.entries(roles)) {
			if (!role.agent) continue;
			const resolved = resolveModel(ctx, role.model);
			if (!resolved) continue;
			if (writeIfChanged(path.join(AGENTS_DIR, `${name}.md`), renderAgent(name, role, resolved.spec))) {
				wrote.push(`agents/${name}.md`);
			}
		}

		// cron per-job model -> ~/.pi/agent/cron/jobs.json
		const jobs = readJson(CRON_JOBS) as { jobs?: Array<Record<string, unknown>> };
		if (Array.isArray(jobs.jobs)) {
			let changed = false;
			for (const job of jobs.jobs) {
				const roleName = typeof job.name === "string" ? config.cron[job.name] : undefined;
				if (!roleName) continue;
				const resolved = resolveModel(ctx, roles[roleName]?.model);
				if (!resolved) continue;
				if (job.model !== resolved.spec) {
					job.model = resolved.spec;
					changed = true;
				}
			}
			if (changed && writeJsonIfChanged(CRON_JOBS, jobs)) wrote.push("cron.jobs");
		}

		return wrote;
	}

	pi.on("session_start", (_event, ctx) => {
		const wrote = sync(ctx);
		if (wrote.length > 0 && ctx.hasUI) ctx.ui.notify(`agent-config: ${wrote.join(", ")}`, "info");
	});

	pi.registerCommand("agent-config", {
		description: "Show the central role registry and what each role resolved to",
		handler: async (_args, ctx) => {
			const wrote = sync(ctx);
			const config = loadConfig();
			const roles = config.roles;
			const lines = Object.entries(roles).map(([name, role]) => {
				const resolved = resolveModel(ctx, role.model);
				const consumer = role.agent ? `agent` : name === "classifier" ? "pi-automode" : name === "supervisor" ? "pi-supervisor" : name === "session" ? "settings" : name === "websearch" ? "web_search tool" : "router";
				const prompt = role.prompt ? ` prompt=${role.prompt}` : "";
				return `${name.padEnd(11)} [${consumer}] ${(role.model ?? []).join(" | ")}${prompt}  →  ${resolved?.spec ?? "(no credentials)"}`;
			});
			const cron = Object.entries(config.cron).map(([job, role]) => `${job} -> ${role}`).join(", ") || "(none)";
			ctx.ui.notify(
				`${CONFIG_PATH}\nsynced: ${wrote.join(", ") || "nothing"}\ncron: ${cron}\n${lines.join("\n")}`,
				"info",
			);
		},
	});
}
