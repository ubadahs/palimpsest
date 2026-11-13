/** The production adapters for all six stages, sharing one session. */

import { buildAdjudicateAdapters } from "../stages/adjudicate/adapters.js";
import { type AdjudicateAdapters } from "../stages/adjudicate/run.js";
import { buildDiscoverAdapters } from "../stages/discover/adapters.js";
import type { DiscoverAdapters } from "../stages/discover/run.js";
import { buildEvidenceAdapters } from "../stages/evidence/adapters.js";
import type { EvidenceAdapters } from "../stages/evidence/run.js";
import { buildPrepareAdapters } from "../stages/prepare/adapters.js";
import { type PrepareAdapters } from "../stages/prepare/run.js";
import {
  createAdapterSession,
  type AdapterSession,
  type ProductionAdapterDeps,
} from "../stages/production.js";
import { buildScopeAdapters } from "../stages/scope/adapters.js";
import { type ScopeAdapters } from "../stages/scope/run.js";

export type ProductionAdapters = {
  session: AdapterSession;
  discover: DiscoverAdapters;
  scope: ScopeAdapters;
  prepare: PrepareAdapters;
  evidence: EvidenceAdapters;
  adjudicate: AdjudicateAdapters;
};

export function buildProductionAdapters(
  deps: ProductionAdapterDeps,
): ProductionAdapters {
  const session = deps.session ?? createAdapterSession();
  const withSession = { ...deps, session };
  return {
    session,
    discover: buildDiscoverAdapters(withSession),
    scope: buildScopeAdapters(withSession),
    prepare: buildPrepareAdapters(withSession),
    evidence: buildEvidenceAdapters(withSession),
    adjudicate: buildAdjudicateAdapters(withSession),
  };
}
