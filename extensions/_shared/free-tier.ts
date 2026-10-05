/**
 * Free layer (config side): load `model-registry.json`, turn it into candidates, and select by an
 * objective. Selection is ACCEPTABLE-based (see docs/free-model-tiers.md) — the selector itself lives
 * in the fork (`@earendil-works/pi-coding-agent/experimental/free-tier`) and is unit-tested there.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type Candidate,
	OBJECTIVES,
	type Objective,
	objectiveOf,
	type Registry,
	registryCandidates,
	type Selection,
	selectCandidate,
} from "@earendil-works/pi-coding-agent/experimental/free-tier";

export const REGISTRY_PATH = path.join(getAgentDir(), "model-registry.json");

export function loadRegistry(): Registry {
	try {
		return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8")) as Registry;
	} catch {
		return { sources: {} };
	}
}

export function candidates(): Candidate[] {
	return registryCandidates(loadRegistry());
}

/** Select a model for a role's objective (falls back to the `routine` objective). */
export function selectForRole(role: string): Selection {
	const registry = loadRegistry();
	return selectCandidate(registryCandidates(registry), objectiveOf(registry, role, OBJECTIVES.routine));
}

/** Select for an explicit objective. */
export function selectForObjective(objective: Objective): Selection {
	return selectCandidate(candidates(), objective);
}

/** A compact status table for `/free`. */
export function freeStatus(): string {
	const registry = loadRegistry();
	const rows = registryCandidates(registry).map(
		(c) => `  ${c.provider}/${c.model}  [${c.quality}] ${c.budget}${c.available === false ? " (unavailable)" : ""}  src=${c.source}`,
	);
	const objectives = Object.entries(registry.objectives ?? {}).map(([role, objective]) => {
		const selection = selectCandidate(registryCandidates(registry), objective);
		const chosen = selection.chosen;
		return `  ${role.padEnd(11)} floor=${objective.floor} ceiling=${objective.ceiling} -> ${chosen ? `${chosen.provider}/${chosen.model}` : `NONE (escalate: ${selection.reason})`}`;
	});
	return [
		`free registry: ${REGISTRY_PATH}`,
		"Candidates:",
		...rows,
		"",
		"By role (acceptable-based):",
		...objectives,
	].join("\n");
}
