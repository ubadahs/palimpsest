import { existsSync, readFileSync } from "node:fs";

import {
  deserializeHandoffMap,
  type DiscoveryHandoffMap,
} from "../domain/discovery-handoff.js";
import type { Result } from "../domain/types.js";

/**
 * Missing, unreadable, invalid, or incomplete sidecars are fatal: switching to
 * the smaller full-screen fetch would change the audit.
 */
export function loadPersistedDiscoveryHandoffs(
  handoffPath: string,
  expectedSeedDois: readonly string[],
): Result<DiscoveryHandoffMap> {
  if (!existsSync(handoffPath)) {
    return {
      ok: false,
      error: `Required persisted discovery handoff is missing: ${handoffPath}`,
    };
  }

  let json: string;
  try {
    json = readFileSync(handoffPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Could not read persisted discovery handoff at ${handoffPath}: ${message}`,
    };
  }

  const parsed = deserializeHandoffMap(json);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `Could not validate persisted discovery handoff at ${handoffPath}: ${parsed.error}`,
    };
  }

  const coverage = validateDiscoveryHandoffCoverage(
    parsed.data,
    expectedSeedDois,
  );
  if (!coverage.ok) {
    return {
      ok: false,
      error: `Persisted discovery handoff at ${handoffPath} is incomplete: ${coverage.error}`,
    };
  }

  return {
    ok: true,
    data: parsed.data,
  };
}

export function validateDiscoveryHandoffCoverage(
  handoffs: DiscoveryHandoffMap,
  expectedSeedDois: readonly string[],
): { ok: true } | { ok: false; error: string } {
  const present = new Set([...handoffs.keys()].map(normalizeDoi));
  const missing = [
    ...new Set(
      expectedSeedDois.map(normalizeDoi).filter((doi) => !present.has(doi)),
    ),
  ];
  return missing.length === 0
    ? { ok: true }
    : {
        ok: false,
        error: `missing shortlist DOI(s): ${missing.join(", ")}`,
      };
}

function normalizeDoi(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/doi\.org\//, "");
}
