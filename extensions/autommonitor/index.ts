/**
 * autommonitor - the user-facing name for the pi-automode gate.
 *
 * pi-automode registers `/automode` (and `/auto-mode`). This extension adds `/autommonitor` as the
 * preferred name without touching the installed package, so `pi update` cannot break it. It
 * forwards to the real command, which owns all the state.
 *
 *   /autommonitor [status|on|off|reload|reset|defaults|config|denials|model ...]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("autommonitor", {
		description: "The auto-monitor (alias for /automode): status, on, off, reload, model, ...",
		handler: async (args, ctx) => {
			const command = args.trim() ? `/automode ${args.trim()}` : "/automode status";
			pi.sendUserMessage(command, { deliverAs: "followUp" });
			ctx.ui.notify(`auto-monitor: ${command}`, "info");
		},
	});
}
