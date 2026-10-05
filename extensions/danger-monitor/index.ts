/**
 * danger-monitor - supervise dangerous actions, Claude Code style.
 *
 * Watches every tool call and flags destructive or irreversible operations before they run:
 * root/home recursive deletes, disk writes, credential overwrites, force pushes, piping a
 * download into a shell, writes to credential or shell-startup files, and so on.
 *
 * Modes (`<agent-dir>/danger-monitor.json`, optional):
 *   { "mode": "confirm", "allow": ["regex", ...] }
 *
 *   confirm  default. Interactive: ask before running. Headless (cron, subagent, -p): block.
 *   block    always block, interactive or not.
 *   warn     notify and allow.
 *   off      disable.
 *
 * `allow` is a list of regexes; if the matched text matches one, the action is allowed. Use it
 * for intentional cases (for example "rm -rf ./dist").
 *
 * `/danger-monitor` shows the mode and recent blocks; `/danger-monitor off|on` toggles.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();
const CONFIG_PATH = path.join(getAgentDir(), "danger-monitor.json");

type Mode = "confirm" | "block" | "warn" | "off";
type Severity = "critical" | "warning";

interface Config {
	mode: Mode;
	allow: string[];
}

interface RuleHit {
	id: string;
	severity: Severity;
	description: string;
}

const DEFAULTS: Config = { mode: "confirm", allow: [] };

function loadConfig(): Config {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
		return {
			mode:
				raw.mode === "block" || raw.mode === "warn" || raw.mode === "off" || raw.mode === "confirm"
					? raw.mode
					: DEFAULTS.mode,
			allow: Array.isArray(raw.allow) ? raw.allow.filter((r): r is string => typeof r === "string") : [],
		};
	} catch {
		return { ...DEFAULTS };
	}
}

function saveConfig(config: Config): void {
	fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function expand(p: string): string {
	if (!p) return p;
	if (p === "~") return HOME;
	if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
	return p;
}

function isUnder(target: string, dir: string): boolean {
	const t = path.resolve(expand(target));
	const d = path.resolve(expand(dir));
	return t === d || t.startsWith(d + path.sep);
}

/** Credential / secret files that must never be written by an agent. */
const PROTECTED_PATHS = [
	"~/.ssh",
	"~/.aws",
	"~/.config/gh/hosts.yml",
	"~/.pi/agent/auth.json",
	"~/.pi/agent/auth.json.bak",
	"~/.codex/auth.json",
	"~/.netrc",
	"~/.npmrc",
	"~/.docker/config.json",
	"~/.config/gcloud",
];

/** Shell start-up files whose modification is a persistence risk. */
const STARTUP_PATHS = ["~/.zshrc", "~/.bashrc", "~/.bash_profile", "~/.zprofile", "~/.profile", "~/.config/fish/config.fish"];

const SECRET_READ_PATTERNS = [
	/(?:^|\s)(?:cat|bat|less|more|head|tail|strings|xxd|od)\s[^\n]*(?:\.ssh\/id_|\.aws\/credentials|\.pi\/agent\/auth\.json|\.codex\/auth\.json|\.netrc|\.npmrc)/i,
	/(?:^|\s)(?:cp|scp|rsync|tar|zip)\s[^\n]*(?:\.ssh\/id_|\.aws\/credentials|\.pi\/agent\/auth\.json|\.codex\/auth\.json)/i,
	/(?:^|\s)(?:cat|bat|less|more|head|tail|grep|rg|awk|sed)\s[^\n]*\.env(?:\b|\.local)/i,
	/(?:^|\s)env\s*\|/,
	/(?:^|\s)printenv\b/,
];

/** Command patterns that are destructive or irreversible. */
function bashHits(command: string): RuleHit[] {
	const hits: RuleHit[] = [];
	const c = command;

	const add = (id: string, severity: Severity, description: string) => hits.push({ id, severity, description });

	// Fork bomb.
	if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;?\s*:/.test(c)) add("fork-bomb", "critical", "shell fork bomb");

	// rm -rf on root, home, cwd, a wildcard, or a system directory.
	const hasRf = /\brm\b[^\n]*(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive[^\n]*--force|--force[^\n]*--recursive)/i.test(c);
	if (hasRf) {
		const rootTarget = /(?:^|\s)(?:\/|\/\*|~|\$HOME|~\/\*|\*|\.|\.\.)(?:\s|$|[;&|])/m.test(c);
		const systemTarget =
			/(?:^|\s)\/(?:etc|usr|var|bin|sbin|lib|lib64|opt|System|Library|Applications|private|dev|proc|sys|boot|root|home)(?:\/|\s|$)/m.test(c);
		if (rootTarget || systemTarget) add("rm-critical", "critical", "recursive force delete of a root/home/system path");
		else add("rm-recursive", "warning", "recursive force delete");
	}

	// Raw disk / filesystem destruction.
	if (/\bmkfs(?:\.[a-z0-9]+)?\b/i.test(c)) add("mkfs", "critical", "format a filesystem");
	if (/\bdd\b[^\n]*\bof=\/dev\//i.test(c)) add("dd-device", "critical", "write raw data to a device");
	if (/(?:^|\s)>\s*\/dev\/(?:sd|disk|nvme)/i.test(c)) add("redirect-device", "critical", "overwrite a block device");

	// Permission damage on system paths.
	if (/\bchmod\b[^\n]*\b777\b[^\n]*\s\/(?:\s|$)/i.test(c)) add("chmod-root", "critical", "chmod 777 on /");
	if (/\bchown\b[^\n]*\s\/(?:\s|$)/i.test(c)) add("chown-root", "critical", "chown on /");

	// Overwriting credential files via redirection or tee.
	if (/(?:>|>>|\btee\b)[^\n]*(?:\.pi\/agent\/auth\.json|\.codex\/auth\.json|\.ssh\/|\.aws\/credentials|\.netrc)/i.test(c)) {
		add("credential-write", "critical", "overwrite a credential file");
	}

	// Force push that can rewrite shared history.
	if (/\bgit\s+push\b/.test(c) && /(?:^|\s)(?:-f|--force)(?:\s|$)/.test(c) && !/--force-with-lease/.test(c)) {
		add("force-push", "critical", "git force push");
	}
	if (/\bgit\s+push\b[^\n]*--mirror\b/.test(c)) add("mirror-push", "critical", "git push --mirror");
	if (/\bgit\s+filter-branch\b/.test(c) || /\bgit\s+filter-repo\b/.test(c)) add("history-rewrite", "critical", "rewrite git history");

	// Excluded by the Claude Code auto-mode rules (remote branch/tag deletion, dropped work,
	// bulk restore/checkout, remote changes).
	if (/\bgit\s+push\b[^\n]*(?:--delete|-d)\b/.test(c) || /\bgit\s+push\b\s+\S+\s+:\S+/.test(c)) {
		add("remote-delete", "critical", "delete a remote branch or tag");
	}
	if (/\bgit\s+tag\s+(?:-d|--delete)\b/.test(c)) add("tag-delete", "warning", "delete a local tag");
	if (/\bgit\s+stash\s+(?:drop|clear)\b/.test(c)) add("stash-drop", "warning", "drop stashed work");
	if (/\bgit\s+(?:restore|checkout)\b[^\n]*\s(?:\.|\*)(?:\s|$)/.test(c)) {
		add("bulk-restore", "warning", "bulk restore/checkout of the working tree");
	}
	if (/\bgit\s+remote\s+(?:add|set-url|remove|rename)\b/.test(c)) add("remote-change", "warning", "change git remotes");

	// Irreversible local git operations.
	if (/\bgit\s+reset\s+--hard\b/.test(c)) add("git-reset-hard", "warning", "git reset --hard discards changes");
	if (/\bgit\s+clean\s+-[a-z]*f/i.test(c)) add("git-clean", "warning", "git clean deletes untracked files");

	// Piping a download into a shell.
	if (/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/i.test(c)) add("pipe-to-shell", "critical", "pipe a download into a shell");
	if (/\b(?:bash|sh|zsh)\s+<\(\s*(?:curl|wget)\b/i.test(c)) add("process-sub-shell", "critical", "run a downloaded script");

	// Privilege escalation and system control.
	if (/(?:^|[;&|]\s*)sudo\s/i.test(c)) add("sudo", "warning", "privilege escalation");
	if (/\b(?:shutdown|reboot|halt|poweroff)\b/i.test(c)) add("system-power", "critical", "shut down or reboot the machine");

	// Secret reads.
	for (const pattern of SECRET_READ_PATTERNS) if (pattern.test(c)) add("secret-read", "warning", "read credential material");
	if (/(?:^|\s)(?:echo|printf)\s[^\n]*\$\{?[A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(c)) {
		add("secret-echo", "warning", "echo a secret environment variable");
	}

	// Database destruction.
	if (/\b(?:drop\s+(?:database|table)|truncate\s+table)\b/i.test(c)) add("sql-destructive", "critical", "destructive SQL");

	return hits;
}

/** File-path checks for write/edit. */
function pathHits(target: string): RuleHit[] {
	if (!target) return [];
	const hits: RuleHit[] = [];
	if (PROTECTED_PATHS.some((p) => isUnder(target, p))) {
		hits.push({ id: "protected-path", severity: "critical", description: "write to a credential/secret path" });
	}
	if (STARTUP_PATHS.some((p) => path.resolve(expand(target)) === path.resolve(expand(p)))) {
		hits.push({ id: "startup-file", severity: "critical", description: "modify a shell start-up file" });
	}
	if (path.resolve(expand(target)).endsWith(path.join(".git", "config"))) {
		hits.push({ id: "git-config", severity: "warning", description: "modify .git/config" });
	}
	return hits;
}

function inputOf(event: { toolName: string; input: unknown }): { command?: string; target?: string; preview: string } {
	const input = (event.input ?? {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	if (event.toolName === "bash" || event.toolName === "powershell") {
		const command = str(input.command) ?? "";
		return { command, preview: command.slice(0, 400) };
	}
	if (event.toolName === "write" || event.toolName === "edit") {
		const target = str(input.file_path) ?? str(input.path) ?? "";
		return { target, preview: target };
	}
	return { preview: "" };
}

export default function (pi: ExtensionAPI) {
	/** Recent blocks, for `/danger-monitor`. */
	const recent: string[] = [];

	function allowed(text: string, config: Config): boolean {
		if (!text) return false;
		return config.allow.some((pattern) => {
			try {
				return new RegExp(pattern, "i").test(text);
			} catch {
				return false;
			}
		});
	}

	pi.on("tool_call", async (event, ctx) => {
		const config = loadConfig();
		if (config.mode === "off") return;

		const { command, target, preview } = inputOf(event);
		const haystack = command ?? target ?? "";
		if (allowed(haystack, config)) return;

		const hits = command !== undefined ? bashHits(command) : pathHits(target ?? "");
		if (hits.length === 0) return;

		const critical = hits.some((h) => h.severity === "critical");
		const label = hits.map((h) => `${h.id} (${h.description})`).join("; ");

		if (config.mode === "warn") {
			if (ctx.hasUI) ctx.ui.notify(`[danger-monitor] ${label}`, "warning");
			return;
		}

		// confirm or block.
		if (config.mode === "confirm" && ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				`danger-monitor: ${hits[0].id}`,
				`${label}\n\n${event.toolName}: ${preview}`,
			);
			if (ok) return;
		}

		const suffix = config.mode === "confirm" && !ctx.hasUI ? " (headless: blocked)" : "";
		recent.unshift(`${new Date().toISOString()}  ${event.toolName}  ${label}${suffix}`);
		recent.splice(20);
		if (ctx.hasUI) ctx.ui.notify(`[danger-monitor] blocked: ${label}`, "error");
		return { block: true, reason: `danger-monitor blocked a ${critical ? "critical" : "risky"} action: ${label}` };
	});

	pi.registerCommand("danger-monitor", {
		description: "Show or toggle the dangerous-action supervisor",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			const config = loadConfig();
			if (action === "off" || action === "on") {
				config.mode = action === "on" ? "confirm" : "off";
				saveConfig(config);
			} else if (action && !["status", "block", "warn", "confirm"].includes(action)) {
				ctx.ui.notify("Usage: /danger-monitor [status|on|off|confirm|block|warn]", "warning");
				return;
			} else if (["block", "warn", "confirm"].includes(action)) {
				config.mode = action as Mode;
				saveConfig(config);
			}

			const effective = loadConfig();
			const log = recent.length > 0 ? `\nrecent:\n  ${recent.slice(0, 5).join("\n  ")}` : "";
			ctx.ui.notify(`danger-monitor: mode=${effective.mode} · allow rules=${effective.allow.length}${log}`, "info");
		},
	});
}
