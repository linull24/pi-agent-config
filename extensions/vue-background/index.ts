/**
 * vue-background — paint the terminal background to match the `vue` theme.
 *
 * pi's theme model has **no app-background role**: the terminal's own background shows through, and
 * the interactive theme only *queries* the terminal colors (OSC 10/11). The Vue theme's signature is
 * its `#002b36` dark-teal background, so this extension emits **OSC 11** on session start and resets
 * it (OSC 111) on shutdown, leaving the terminal as it found it.
 *
 * Scope: interactive only. Harmless elsewhere (the sequences are ignored).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The Vue theme background. */
const BACKGROUND = "#002b36";
const SET_BACKGROUND = `\x1b]11;${BACKGROUND}\x07`;
const RESET_BACKGROUND = "\x1b]111\x07";

export default function (pi: ExtensionAPI) {
	let painted = false;
	const paint = (): void => {
		if (painted) return;
		painted = true;
		try {
			process.stdout.write(SET_BACKGROUND);
		} catch {
			// a non-tty stdout must never break the session
		}
	};
	const restore = (): void => {
		if (!painted) return;
		painted = false;
		try {
			process.stdout.write(RESET_BACKGROUND);
		} catch {
			// best effort
		}
	};

	pi.on("session_start", () => paint());
	pi.on("session_shutdown", () => restore());
}
