/**
 * `/free` — inspect the free layer: which sources are free/cheap and which model each role would get
 * under its objective (acceptable-based selection, not a fallback chain).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { freeStatus, selectForRole } from "../_shared/free-tier.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("free", {
		description: "Show the free-model registry and what each role would select",
		handler: (args, ctx) => {
			const role = args.trim();
			if (role.length > 0) {
				const selection = selectForRole(role);
				const chosen = selection.chosen;
				ctx.ui.notify(
					chosen
						? `${role}: ${chosen.provider}/${chosen.model} [${chosen.quality}] ${chosen.budget} (${selection.reason})`
						: `${role}: none acceptable - ${selection.reason} (escalate or lower the floor)`,
					chosen ? "info" : "warning",
				);
				return;
			}
			ctx.ui.notify(freeStatus(), "info");
		},
	});
}
