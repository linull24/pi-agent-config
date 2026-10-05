/**
 * Router - one selectable model that picks the right physical model per request.
 *
 * Registers `router/auto`. Model targets come from the central registry
 * `~/.pi/agent/model-roles.json` (see the `model-roles` extension):
 *
 *   daily     -> daily work, execution, compaction, failover target of the OpenAI side
 *   research  -> hard thinking and research
 *   failover  -> OpenAI-side fallback partner for DeepSeek
 *
 * Routing policy:
 * - Daily work  -> the `daily` role (default `deepseek/deepseek-flash`). `deepseek-v4-pro` is
 *   never selected automatically.
 * - Hard thinking or research -> the `research` role (default GPT-6 Astra). Fires when the
 *   selected thinking level is `high`/`xhigh`, when the message looks like research / hard
 *   reasoning, or when a short follow-up continues a turn already on the research model.
 * - Execution -> once the turn makes its first successful `edit`/`write`, the rest of that turn
 *   goes back to the `daily` model. A new user message re-evaluates the policy from scratch.
 * - Failover -> the `daily` and `failover` roles back each other up. A failed research turn
 *   falls back to `daily`. Both retryable errors and non-retryable ones (such as the OpenAI
 *   `subscription_sharing_user_not_eligible` 403) are covered: the run is continued once on the
 *   fallback model via the `agent_before_settle` boundary. OpenRouter is never used.
 * - Requests outside the agent loop (compaction summaries, extension calls) use `daily`.
 *
 * The role candidate order decides the OpenAI provider: put `openai-codex/...` before
 * `openai/...` to prefer the Codex OAuth (works on a ChatGPT Plus/Pro plan without token
 * sharing); flip it to prefer "Sign in with ChatGPT" token sharing.
 */

import type { Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { resolveRole } from "../_shared/roles.ts";

interface Target {
	provider: string;
	id: string;
}

/** Abstract model slots, mapped to roles in model-roles.json. */
type TargetKind = "daily" | "research" | "failover";

/** Providers that make up the OpenAI side, for failover decisions and follow-up detection. */
const OPENAI_PROVIDERS = new Set(["openai-codex", "openai"]);
const FAILOVER_PROVIDERS = new Set(["deepseek", ...OPENAI_PROVIDERS]);

/** Tools whose successful result means execution has started. */
const EDIT_TOOLS = new Set(["edit", "write"]);

/** Maximum automatic error-driven failovers before the turn is allowed to end. */
const MAX_ERROR_FALLBACKS = 2;

/**
 * Messages that look like research or hard reasoning and should go to the research model.
 * Everything else is treated as ordinary daily work.
 */
const RESEARCH_PATTERN =
	/研究|科研|论文|文献|综述|调研|推导|证明|论证|定理|数学|算法|实验|假设|理论|根因|疑难|溯因|research|paper|theorem|prove|proof|deriv|survey|literature|hypothesis|experiment|root cause|deep dive|mathematical|first principles|reasoning/i;

interface RouterState {
	/** "thinking" explores/plans; "execution" has already started editing. */
	phase: "thinking" | "execution";
	provider: string;
	id: string;
}

type RouterRequest = ModelRouteRequest<RouterState>;
type Level = ModelRouteRequest["thinkingLevel"];

/** DeepSeek Flash exposes low/high/max; keep low, map everything else up to high. */
function deepseekLevel(level: Level): Level {
	if (level === "max") return "max";
	if (level === "low") return "low";
	return "high";
}

/** The research model supports low..max; never send it less than "high" once we chose it. */
function researchLevel(level: Level): Level {
	return level === "high" || level === "xhigh" || level === "max" ? level : "high";
}

/** Thinking level to request from a resolved target. */
function levelForTarget(target: Target, requested: Level): Level {
	if (target.provider === "deepseek") return deepseekLevel(requested);
	if (/astra|sol/i.test(target.id)) return researchLevel(requested);
	return requested; // failover partner supports every level.
}

function targetForKind(ctx: ExtensionContext, kind: TargetKind): Target {
	const resolved = resolveRole(ctx, kind);
	return resolved
		? { provider: resolved.provider, id: resolved.id }
		: { provider: "deepseek", id: "deepseek-flash" };
}

function routeToTarget(
	ctx: ExtensionContext,
	target: Target,
	requested: Level,
	state?: RouterState,
): ModelRoute<RouterState> {
	const model = ctx.modelRegistry.find(target.provider, target.id);
	if (!model) throw new Error(`Model ${target.provider}/${target.id} is not in the catalog`);
	return { model, thinkingLevel: levelForTarget(target, requested), state };
}

function routeToKind(
	ctx: ExtensionContext,
	kind: TargetKind,
	requested: Level,
	state?: RouterState,
): ModelRoute<RouterState> {
	return routeToTarget(ctx, targetForKind(ctx, kind), requested, state);
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Whether a tool call since the last user message edited a file successfully. */
function editedThisTurn(messages: readonly Message[]): boolean {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	return messages
		.slice(lastUser + 1)
		.some((message) => message.role === "toolResult" && EDIT_TOOLS.has(message.toolName) && !message.isError);
}

/** The latest assistant message, when it is a provider error we can fail over from. */
function lastAssistantError(messages: readonly Message[]): { provider: string } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error" && message.errorMessage && FAILOVER_PROVIDERS.has(message.provider)) {
			return { provider: message.provider };
		}
		return undefined; // The last assistant message is not a failover-eligible error.
	}
	return undefined;
}

/** Which slot to use after `provider` failed: OpenAI side -> daily, otherwise -> failover. */
function failoverKind(provider: string): TargetKind {
	return OPENAI_PROVIDERS.has(provider) ? "daily" : "failover";
}

/** Slot for a fresh thinking phase: research for hard/research work, daily otherwise. */
function chooseThinkingKind(request: RouterRequest): TargetKind {
	const level = request.thinkingLevel;
	if (level === "high" || level === "xhigh") return "research";

	const text = lastUserText(request.messages);
	if (RESEARCH_PATTERN.test(text)) return "research";

	// A short follow-up continues the previous turn; keep it on the research model.
	const previous = request.previous?.model;
	if (previous && OPENAI_PROVIDERS.has(previous.provider) && text.length < 200) return "research";

	return "daily";
}

export default function (pi: ExtensionAPI) {
	/** Consecutive automatic failovers for the current error episode. */
	let errorFallbacks = 0;

	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "auto",
		name: "Auto (DeepSeek ⇄ OpenAI)",
		thinkingLevels: ["low", "medium", "high", "xhigh"],
		// Shown until the first response. 272k is the OpenAI-side window; DeepSeek is larger.
		contextWindow: 272_000,
		maxTokens: 128_000,
		route(request, ctx) {
			// --- Failover on retryable errors (429, 5xx, network, overload). ---
			if (request.reason === "retry") {
				const phase = request.state?.phase ?? "thinking";
				const failed = request.failed?.model;
				const kind = failed && FAILOVER_PROVIDERS.has(failed.provider) ? failoverKind(failed.provider) : "daily";
				const target = targetForKind(ctx, kind);
				return routeToTarget(ctx, target, request.thinkingLevel, { phase, ...target });
			}

			// --- Requests outside the agent loop (compaction, extension calls). ---
			if (request.reason === "direct") {
				return routeToKind(ctx, "daily", request.thinkingLevel);
			}

			const error = lastAssistantError(request.messages);

			// --- New user turn, or a failover continuation of an errored turn. ---
			if (request.reason === "user" || !request.state) {
				const kind: TargetKind = error ? failoverKind(error.provider) : chooseThinkingKind(request);
				const target = targetForKind(ctx, kind);
				return routeToTarget(ctx, target, request.thinkingLevel, { phase: "thinking", ...target });
			}

			// --- Continuation within a turn. ---
			const state = request.state;
			if (error) {
				const target = targetForKind(ctx, failoverKind(error.provider));
				return routeToTarget(ctx, target, request.thinkingLevel, { phase: state.phase, ...target });
			}
			// Execution started: hand the rest of the turn to the daily model.
			if (state.phase === "thinking" && editedThisTurn(request.messages)) {
				const target = targetForKind(ctx, "daily");
				return routeToTarget(ctx, target, request.thinkingLevel, { phase: "execution", ...target });
			}
			return routeToTarget(ctx, { provider: state.provider, id: state.id }, request.thinkingLevel);
		},
	});

	// Reset the failover budget once a request succeeds.
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; stopReason?: string };
		if (message.role === "assistant" && message.stopReason !== "error") errorFallbacks = 0;
	});

	// When a run ends on a provider error, continue it once on the fallback model.
	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "error" || errorFallbacks >= MAX_ERROR_FALLBACKS) return;
		if (!lastAssistantErrorFromBranch(ctx)) return;
		errorFallbacks++;
		return {
			entries: [
				{
					type: "custom_message",
					customType: "router-provider-fallback",
					content:
						"(Automatic fallback) The previous model call failed. Continue and complete the original request now using the fallback model.",
					display: true,
				},
			],
			continue: true,
		};
	});
}

/** Latest assistant entry on the session branch, when it is a failover-eligible error. */
function lastAssistantErrorFromBranch(ctx: ExtensionContext): { provider: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			stopReason?: string;
			errorMessage?: string;
			provider?: string;
		};
		if (message.role !== "assistant") continue;
		if (
			message.stopReason === "error" &&
			message.errorMessage &&
			message.provider &&
			FAILOVER_PROVIDERS.has(message.provider)
		) {
			return { provider: message.provider };
		}
		return undefined;
	}
	return undefined;
}
