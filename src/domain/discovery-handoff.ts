/**
 * Rich handoff produced by attribution-first discovery and consumed by
 * downstream stages (screen, extract) to avoid redundant I/O and LLM calls.
 *
 * The pipeline persists this under `inputs/discovery-handoffs.json`. Fresh and
 * resumed runs both cross the same serialize/validate/deserialize boundary
 * before consuming it, so the in-memory shortcut cannot bypass validation.
 * Stage primary JSON artifacts remain the canonical downstream machine
 * outputs; this bundle is a reusable provenance and acceleration artifact.
 *
 * Structure:
 *   - One `DiscoveryHandoff` per seed DOI.
 *   - All families from the same DOI share the same `resolvedPaper`,
 *     `citingPapersRaw`, and `mentionsByPaperId`.
 *   - Per-family grounding is looked up via `groundingByFamilyId`.
 */

import { z } from "zod";

import {
  resolvedPaperSchema,
  type ResolvedPaper,
  type Result,
} from "./common.js";
import {
  harvestedSeedMentionSchema,
  type HarvestedSeedMention,
} from "./discovery.js";
import {
  familyGroundingTraceSchema,
  type FamilyGroundingTrace,
} from "./family-grounding-trace.js";
import {
  canonicalSerialize,
  canonicalSha256,
} from "../shared/stable-identity.js";

export type DiscoveryHandoff = {
  doi: string;

  /** Resolved seed paper metadata. */
  resolvedPaper: ResolvedPaper;

  /**
   * All citing papers from OpenAlex at discovery time (up to the discovery
   * fetch limit, typically 200). This is larger than the screen fetch limit (50)
   * and allows the thin screen path to skip its own OpenAlex call while covering
   * more of the neighborhood.
   *
   * The list is ordered as returned by OpenAlex (newest first within availability
   * tier). Pre-dedup count equals `citingPapersRaw.length`.
   */
  citingPapersRaw: ResolvedPaper[];

  /**
   * Mentions pre-harvested during discovery, keyed by citing-paper ID.
   * Only papers that were selected for probing are present.
   * Papers outside the probe set (e.g. beyond probeBudget or lacking full text)
   * will not have an entry — the extract stage must fall back to full harvest
   * for those.
   */
  mentionsByPaperId: Map<string, HarvestedSeedMention[]>;

  /**
   * Per-family grounding traces, keyed by familyId.
   * Thin screen uses these instead of re-running LLM grounding.
   */
  groundingByFamilyId: Map<string, FamilyGroundingTrace>;
};

/** Map from seed DOI → DiscoveryHandoff. One entry per discovered DOI. */
export type DiscoveryHandoffMap = Map<string, DiscoveryHandoff>;

// ---------------------------------------------------------------------------
// Serialization — used to persist handoffs to disk so that --run-id resume
// can recover the thin screen path without re-running expensive discovery.
// ---------------------------------------------------------------------------

export const discoveryHandoffSchemaVersion = 1 as const;
export const discoveryHandoffArtifactVersion = 1 as const;

const sha256DigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest");

export const serializedDiscoveryHandoffSchema = z
  .object({
    doi: z.string().min(1),
    resolvedPaper: resolvedPaperSchema,
    citingPapersRaw: z.array(resolvedPaperSchema),
    mentionsByPaperId: z.record(
      z.string().min(1),
      z.array(harvestedSeedMentionSchema),
    ),
    groundingByFamilyId: z.record(
      z.string().min(1),
      familyGroundingTraceSchema,
    ),
  })
  .strict()
  .superRefine((handoff, context) => {
    for (const [paperId, mentions] of Object.entries(
      handoff.mentionsByPaperId,
    )) {
      if (mentions.some((mention) => mention.citingPaperId !== paperId)) {
        context.addIssue({
          code: "custom",
          path: ["mentionsByPaperId", paperId],
          message: "Mention citingPaperId does not match its map key",
        });
      }
    }
    for (const [familyId, trace] of Object.entries(
      handoff.groundingByFamilyId,
    )) {
      if (trace.familyId !== familyId) {
        context.addIssue({
          code: "custom",
          path: ["groundingByFamilyId", familyId],
          message: "Grounding familyId does not match its map key",
        });
      }
    }
  });
export type SerializedDiscoveryHandoff = z.infer<
  typeof serializedDiscoveryHandoffSchema
>;

const serializedDiscoveryHandoffMapSchema = z
  .record(z.string().min(1), serializedDiscoveryHandoffSchema)
  .superRefine((handoffs, context) => {
    for (const [doi, handoff] of Object.entries(handoffs)) {
      if (normalizeDoi(doi) !== normalizeDoi(handoff.doi)) {
        context.addIssue({
          code: "custom",
          path: [doi, "doi"],
          message: "Handoff DOI does not match its map key",
        });
      }
    }
  });

export const discoveryHandoffFileSchema = z
  .object({
    schemaVersion: z.literal(discoveryHandoffSchemaVersion),
    artifactVersion: z.literal(discoveryHandoffArtifactVersion),
    artifactType: z.literal("palimpsest-discovery-handoffs"),
    contentHash: sha256DigestSchema,
    handoffs: serializedDiscoveryHandoffMapSchema,
  })
  .strict()
  .superRefine((file, context) => {
    const expected = computeDiscoveryHandoffContentHash(file.handoffs);
    if (file.contentHash !== expected) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "contentHash does not match the serialized handoffs",
      });
    }
  });
export type DiscoveryHandoffFile = z.infer<typeof discoveryHandoffFileSchema>;

export type DiscoveryHandoffBoundary = {
  serialized: string;
  handoffs: DiscoveryHandoffMap;
};

/**
 * Validate a fresh in-memory handoff through the same representation consumed
 * on resume. The returned map is reconstructed only from validated JSON data.
 */
export function validateDiscoveryHandoffBoundary(
  map: DiscoveryHandoffMap,
): Result<DiscoveryHandoffBoundary> {
  const serialized = serializeHandoffMap(map);
  if (!serialized.ok) {
    return serialized;
  }
  const restored = deserializeHandoffMap(serialized.data);
  if (!restored.ok) {
    return restored;
  }
  return {
    ok: true,
    data: {
      serialized: serialized.data,
      handoffs: restored.data,
    },
  };
}

/** Serialize and validate the current versioned handoff representation. */
export function serializeHandoffMap(map: DiscoveryHandoffMap): Result<string> {
  const plain: Record<string, unknown> = {};
  for (const [doi, handoff] of sortedMapEntries(map)) {
    plain[doi] = {
      doi: handoff.doi,
      resolvedPaper: handoff.resolvedPaper,
      citingPapersRaw: handoff.citingPapersRaw,
      mentionsByPaperId: Object.fromEntries(
        sortedMapEntries(handoff.mentionsByPaperId),
      ),
      groundingByFamilyId: Object.fromEntries(
        sortedMapEntries(handoff.groundingByFamilyId),
      ),
    };
  }

  const handoffs = serializedDiscoveryHandoffMapSchema.safeParse(plain);
  if (!handoffs.success) {
    return {
      ok: false,
      error: formatHandoffValidationError(
        "Invalid fresh discovery handoff",
        handoffs.error,
      ),
    };
  }

  const file = discoveryHandoffFileSchema.parse({
    schemaVersion: discoveryHandoffSchemaVersion,
    artifactVersion: discoveryHandoffArtifactVersion,
    artifactType: "palimpsest-discovery-handoffs",
    contentHash: computeDiscoveryHandoffContentHash(handoffs.data),
    handoffs: handoffs.data,
  });
  return { ok: true, data: `${canonicalSerialize(file)}\n` };
}

/** Parse only the current versioned, content-hashed representation. */
export function deserializeHandoffMap(
  json: string,
): Result<DiscoveryHandoffMap> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Invalid discovery handoff JSON: ${message}`,
    };
  }

  const parsed = discoveryHandoffFileSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: formatHandoffValidationError(
        "Invalid versioned discovery handoff",
        parsed.error,
      ),
    };
  }
  return {
    ok: true,
    data: toDiscoveryHandoffMap(parsed.data.handoffs),
  };
}

function computeDiscoveryHandoffContentHash(
  handoffs: Record<string, SerializedDiscoveryHandoff>,
): string {
  return canonicalSha256({
    contentVersion: 1,
    handoffs,
  });
}

function toDiscoveryHandoffMap(
  plain: Record<string, SerializedDiscoveryHandoff>,
): DiscoveryHandoffMap {
  const map: DiscoveryHandoffMap = new Map();
  for (const [doi, serialized] of Object.entries(plain).sort(
    ([left], [right]) => compareCodeUnits(left, right),
  )) {
    map.set(doi, {
      doi: serialized.doi,
      resolvedPaper: serialized.resolvedPaper,
      citingPapersRaw: serialized.citingPapersRaw,
      mentionsByPaperId: new Map(
        Object.entries(serialized.mentionsByPaperId).sort(([left], [right]) =>
          compareCodeUnits(left, right),
        ),
      ),
      groundingByFamilyId: new Map(
        Object.entries(serialized.groundingByFamilyId).sort(([left], [right]) =>
          compareCodeUnits(left, right),
        ),
      ),
    });
  }
  return map;
}

function sortedMapEntries<T>(map: ReadonlyMap<string, T>): [string, T][] {
  return [...map.entries()].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  );
}

function formatHandoffValidationError(
  prefix: string,
  error: z.ZodError,
): string {
  const issue = error.issues[0];
  const path = issue?.path.join(".") || "<root>";
  return `${prefix} at ${path}: ${issue?.message ?? error.message}`;
}

function normalizeDoi(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/doi\.org\//, "");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
