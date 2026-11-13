/**
 * Cross-citer claim equivalence for Discover.
 *
 * A seed's claims are clustered by one model request when they fit in one
 * block. A heavily cited seed yields thousands of claims, which fit neither a
 * request nor a reply, so they are clustered in two levels instead:
 *
 * 1. claims with the same normalized text form one unit (they are equal, so
 *    no model needs to say so);
 * 2. units are split into blocks of at most `blockSize` by BM25 similarity:
 *    the heaviest unassigned unit seeds a block and takes its nearest
 *    unassigned neighbours, and blocks left under half full are packed
 *    together whole;
 * 3. each block is clustered by the model, side by side;
 * 4. the block clusters are merged by the same request over one
 *    representative claim per cluster. When the representatives exceed a
 *    block they are blocked the same way and merged in rounds, until one
 *    request holds them all or a round joins nothing.
 *
 * Every input to every request is fixed before any request is sent: blocks
 * depend only on the claims, and a round depends only on the replies of the
 * round before, which are read in block order. So the result is the same at
 * any concurrency and in any completion order.
 */

import type {
  BlockedClusteringCall,
  BlockedMergeCall,
  DiscoverAttributedClaimRecord,
  DiscoverClaimEquivalence,
} from "../contract/lean-artifacts.js";
import type { ModelExecution } from "../contract/model-execution.js";
import { normalizeDiscoverClaimText } from "../contract/claim-unit.js";
import { buildBm25Index, scoreBm25Index } from "../retrieval/bm25.js";
import { pMap } from "../shared/concurrency.js";
import { compareCodeUnits } from "../shared/order.js";
import { canonicalSerialize } from "../shared/stable-identity.js";

/**
 * Claims per clustering request. About 130 input tokens a claim puts a block
 * near 20k tokens, and its reply stays well inside the output cap.
 */
export const CLAIM_CLUSTER_BLOCK_SIZE = 150;

export type ClaimGroup = {
  seedId: string;
  canonicalClaim: string;
  records: DiscoverAttributedClaimRecord[];
  equivalence: DiscoverClaimEquivalence;
};

/** What one clustering request returned, fatal failures already thrown. */
export type ClusteringCallOutcome =
  | {
      status: "completed";
      clusters: Array<{ canonicalClaim: string; claimRecordIds: string[] }>;
      execution: ModelExecution;
    }
  | { status: "failed"; reason: string; execution: ModelExecution };

export type ClusteringCall = (
  records: readonly DiscoverAttributedClaimRecord[],
) => Promise<ClusteringCallOutcome>;

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function byClaimRecordId(
  left: DiscoverAttributedClaimRecord,
  right: DiscoverAttributedClaimRecord,
): number {
  return compareCodeUnits(left.claimRecordId, right.claimRecordId);
}

/** Exact normalized-text groups, each in claim-record-ID order. */
function exactTextGroups(
  records: readonly DiscoverAttributedClaimRecord[],
): DiscoverAttributedClaimRecord[][] {
  const groups = new Map<string, DiscoverAttributedClaimRecord[]>();
  for (const record of records) {
    const key = canonicalSerialize({
      seedId: record.seedId,
      normalizedClaim: normalizeDiscoverClaimText(record.extractedClaimText),
    });
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  return [...groups.values()].map((group) => [...group].sort(byClaimRecordId));
}

function exactCanonicalClaim(
  records: readonly DiscoverAttributedClaimRecord[],
): string {
  return records
    .map((record) => collapseWhitespace(record.extractedClaimText))
    .sort(compareCodeUnits)[0]!;
}

/** Deterministic fallback: one group per exact normalized claim text. */
function groupRecordsByNormalizedText(
  records: readonly DiscoverAttributedClaimRecord[],
  fallbackReason?: string,
): ClaimGroup[] {
  return exactTextGroups(records).map((ordered) => ({
    seedId: ordered[0]!.seedId,
    canonicalClaim: exactCanonicalClaim(ordered),
    records: ordered,
    equivalence: {
      method: "exact_normalized_text",
      ...(fallbackReason ? { fallbackReason } : {}),
    },
  }));
}

/**
 * Repair a model partition deterministically: unknown ids are dropped, a
 * record named twice keeps its first cluster, and records the model omitted
 * become singleton clusters. Empty clusters vanish. The repair is recorded so
 * the artifact says how much of the grouping was the model's.
 */
function repairClusterPartition(
  clusters: ReadonlyArray<{ canonicalClaim: string; claimRecordIds: string[] }>,
  records: readonly DiscoverAttributedClaimRecord[],
): {
  clusters: Array<{ canonicalClaim: string; claimRecordIds: string[] }>;
  repairNote: string | undefined;
} {
  const known = new Set(records.map((record) => record.claimRecordId));
  const seen = new Set<string>();
  let unknown = 0;
  let duplicate = 0;
  const repaired = clusters
    .map((cluster) => ({
      canonicalClaim: cluster.canonicalClaim,
      claimRecordIds: cluster.claimRecordIds.filter((claimRecordId) => {
        if (!known.has(claimRecordId)) {
          unknown += 1;
          return false;
        }
        if (seen.has(claimRecordId)) {
          duplicate += 1;
          return false;
        }
        seen.add(claimRecordId);
        return true;
      }),
    }))
    .filter((cluster) => cluster.claimRecordIds.length > 0);
  const omitted = records.filter((record) => !seen.has(record.claimRecordId));
  for (const record of omitted) {
    repaired.push({
      canonicalClaim: collapseWhitespace(record.extractedClaimText),
      claimRecordIds: [record.claimRecordId],
    });
  }
  const notes = [
    unknown > 0 ? `${String(unknown)} unknown claim reference(s) dropped` : "",
    duplicate > 0
      ? `${String(duplicate)} duplicate reference(s) kept in first cluster`
      : "",
    omitted.length > 0
      ? `${String(omitted.length)} omitted claim(s) placed in singleton clusters`
      : "",
  ].filter((note) => note.length > 0);
  return {
    clusters: repaired,
    repairNote: notes.length > 0 ? notes.join("; ") : undefined,
  };
}

/**
 * Share of a seed's score against itself that a neighbour must reach to join
 * its block. Without a floor, common words alone fill a block, and a finding's
 * paraphrases scatter across blocks that the merge pass then sees apart.
 */
const BLOCK_SIMILARITY_FLOOR = 0.25;

/** Something to block: a key, the text BM25 sees, and how much it weighs. */
type BlockItem = { key: string; text: string; weight: number };

/**
 * Split items into blocks of at most `blockSize` by BM25 similarity.
 * Deterministic: items are taken in key order, the heaviest unassigned item
 * (ties by key) seeds each block, its unassigned neighbours join by
 * descending score (ties by key), and blocks under half full are packed
 * whole, in creation order, into shared blocks. Items inside a
 * block are returned in key order, which is the order a prompt lists them.
 */
export function partitionIntoSimilarityBlocks(
  items: readonly BlockItem[],
  blockSize: number,
): string[][] {
  if (!Number.isInteger(blockSize) || blockSize < 2) {
    throw new Error(`Block size must be an integer of at least 2`);
  }
  const ordered = [...items].sort((left, right) =>
    compareCodeUnits(left.key, right.key),
  );
  if (ordered.length <= blockSize) {
    return ordered.length === 0 ? [] : [ordered.map((item) => item.key)];
  }
  const index = buildBm25Index(ordered, (item) => item.text);
  const seedOrder = [...ordered].sort(
    (left, right) =>
      right.weight - left.weight || compareCodeUnits(left.key, right.key),
  );
  const assigned = new Set<string>();
  const blocks: string[][] = [];
  for (const seed of seedOrder) {
    if (assigned.has(seed.key)) continue;
    assigned.add(seed.key);
    const block = [seed.key];
    // A neighbour must share a real part of the seed's wording, not only
    // common words; weaker matches are left to seed or join other blocks.
    const selfScore =
      scoreBm25Index(index, seed.text, (item) => item.key === seed.key)[0]
        ?.score ?? 0;
    const floor = selfScore * BLOCK_SIMILARITY_FLOOR;
    const neighbours = scoreBm25Index(
      index,
      seed.text,
      (item) => !assigned.has(item.key),
    )
      .filter((neighbour) => neighbour.score >= floor)
      .sort(
        (left, right) =>
          right.score - left.score ||
          compareCodeUnits(left.document.key, right.document.key),
      );
    for (const neighbour of neighbours) {
      if (block.length >= blockSize) break;
      block.push(neighbour.document.key);
      assigned.add(neighbour.document.key);
    }
    blocks.push(block);
  }

  // Pack blocks under half full whole, in creation order, so a small block of
  // similar items stays together; every packed block but the last is then
  // more than half full.
  const minimum = Math.ceil(blockSize / 2);
  const full = blocks.filter((block) => block.length >= minimum);
  let bin: string[] = [];
  for (const block of blocks.filter((entry) => entry.length < minimum)) {
    if (bin.length + block.length > blockSize) {
      full.push(bin);
      bin = [];
    }
    bin.push(...block);
  }
  if (bin.length > 0) full.push(bin);
  return full.map((block) => [...block].sort(compareCodeUnits));
}

/** A cluster under construction, with the calls that shaped it. */
type WorkingCluster = {
  /** Lowest claim-record ID; a stable key for ordering and blocking. */
  key: string;
  canonicalClaim: string;
  /** Exact-text groups, each in claim-record-ID order. */
  units: DiscoverAttributedClaimRecord[][];
  blocks: BlockedClusteringCall[];
  merges: BlockedMergeCall[];
};

function representativeOf(
  cluster: WorkingCluster,
): DiscoverAttributedClaimRecord {
  const heaviest = [...cluster.units].sort(
    (left, right) =>
      right.length - left.length ||
      compareCodeUnits(left[0]!.claimRecordId, right[0]!.claimRecordId),
  )[0]!;
  return heaviest[0]!;
}

function clusterKey(units: readonly DiscoverAttributedClaimRecord[][]): string {
  return units.map((unit) => unit[0]!.claimRecordId).sort(compareCodeUnits)[0]!;
}

function compareCalls(
  left: { round?: number; blockIndex: number },
  right: { round?: number; blockIndex: number },
): number {
  return (
    (left.round ?? 0) - (right.round ?? 0) || left.blockIndex - right.blockIndex
  );
}

function callRecord(
  blockIndex: number,
  outcome: ClusteringCallOutcome,
  repairNote: string | undefined,
): BlockedClusteringCall {
  return outcome.status === "failed"
    ? {
        blockIndex,
        outcome: "fallback",
        execution: outcome.execution,
        fallbackReason: outcome.reason,
      }
    : {
        blockIndex,
        outcome: "model",
        execution: outcome.execution,
        ...(repairNote ? { repairNote } : {}),
      };
}

/**
 * Cluster one seed's claims. `call` sends one clustering request; it throws
 * on fatal provider failures and returns a typed failure otherwise.
 */
export async function clusterSeedClaims(input: {
  records: readonly DiscoverAttributedClaimRecord[];
  call: ClusteringCall | undefined;
  blockSize?: number;
  concurrency?: number;
  onExecution?: (execution: ModelExecution) => void;
}): Promise<ClaimGroup[]> {
  const blockSize = input.blockSize ?? CLAIM_CLUSTER_BLOCK_SIZE;
  const concurrency = input.concurrency ?? 1;
  const records = input.records;
  const units = exactTextGroups(records).sort((left, right) =>
    byClaimRecordId(left[0]!, right[0]!),
  );
  if (!input.call || units.length < 2) {
    return groupRecordsByNormalizedText(records);
  }
  const seedId = records[0]!.seedId;

  // Claims that fit one request keep the single call, every claim listed.
  if (records.length <= blockSize) {
    const outcome = await input.call(records);
    input.onExecution?.(outcome.execution);
    if (outcome.status === "failed") {
      return groupRecordsByNormalizedText(records, outcome.reason);
    }
    const repaired = repairClusterPartition(outcome.clusters, records);
    const recordsById = new Map(
      records.map((record) => [record.claimRecordId, record]),
    );
    return repaired.clusters.map((cluster) => ({
      seedId,
      canonicalClaim: collapseWhitespace(cluster.canonicalClaim),
      records: cluster.claimRecordIds
        .map((claimRecordId) => recordsById.get(claimRecordId)!)
        .sort(byClaimRecordId),
      equivalence: {
        method: "model",
        execution: outcome.execution,
        ...(repaired.repairNote ? { repairNote: repaired.repairNote } : {}),
      },
    }));
  }

  // Level one: block the exact-text units and cluster each block, listing
  // one representative claim per unit.
  const unitByKey = new Map(
    units.map((unit) => [unit[0]!.claimRecordId, unit]),
  );
  const blocks = partitionIntoSimilarityBlocks(
    units.map((unit) => ({
      key: unit[0]!.claimRecordId,
      text: unit[0]!.extractedClaimText,
      weight: unit.length,
    })),
    blockSize,
  );
  const blockOutcomes = await pMap(
    blocks,
    async (keys) =>
      keys.length < 2
        ? undefined
        : input.call!(keys.map((key) => unitByKey.get(key)![0]!)),
    { concurrency },
  );

  let clusters: WorkingCluster[] = [];
  blocks.forEach((keys, blockIndex) => {
    const outcome = blockOutcomes[blockIndex];
    const blockUnits = keys.map((key) => unitByKey.get(key)!);
    if (!outcome) {
      clusters.push({
        key: keys[0]!,
        canonicalClaim: exactCanonicalClaim(blockUnits[0]!),
        units: blockUnits,
        blocks: [{ blockIndex, outcome: "single_claim" }],
        merges: [],
      });
      return;
    }
    input.onExecution?.(outcome.execution);
    if (outcome.status === "failed") {
      for (const unit of blockUnits) {
        clusters.push({
          key: unit[0]!.claimRecordId,
          canonicalClaim: exactCanonicalClaim(unit),
          units: [unit],
          blocks: [callRecord(blockIndex, outcome, undefined)],
          merges: [],
        });
      }
      return;
    }
    const representatives = blockUnits.map((unit) => unit[0]!);
    const repaired = repairClusterPartition(outcome.clusters, representatives);
    const call = callRecord(blockIndex, outcome, repaired.repairNote);
    for (const cluster of repaired.clusters) {
      const memberUnits = cluster.claimRecordIds.map(
        (claimRecordId) => unitByKey.get(claimRecordId)!,
      );
      clusters.push({
        key: clusterKey(memberUnits),
        canonicalClaim: collapseWhitespace(cluster.canonicalClaim),
        units: memberUnits,
        blocks: [call],
        merges: [],
      });
    }
  });

  // Level two: merge clusters across blocks, in rounds. A single block has
  // nothing to merge across.
  if (blocks.length > 1) {
    clusters = await mergeClusters({
      clusters,
      call: input.call,
      blockSize,
      concurrency,
      ...(input.onExecution ? { onExecution: input.onExecution } : {}),
    });
  }

  return clusters.map((cluster) => ({
    seedId,
    canonicalClaim: cluster.canonicalClaim,
    records: cluster.units.flat().sort(byClaimRecordId),
    equivalence: {
      method: "blocked_model",
      blockCount: blocks.length,
      blocks: [...cluster.blocks].sort(compareCalls),
      merges: [...cluster.merges].sort(compareCalls),
    },
  }));
}

async function mergeClusters(input: {
  clusters: WorkingCluster[];
  call: ClusteringCall;
  blockSize: number;
  concurrency: number;
  onExecution?: (execution: ModelExecution) => void;
}): Promise<WorkingCluster[]> {
  let clusters = input.clusters;
  for (let round = 1; ; round++) {
    if (clusters.length < 2) return clusters;
    const byKey = new Map(clusters.map((cluster) => [cluster.key, cluster]));
    const representativeByKey = new Map(
      clusters.map((cluster) => [cluster.key, representativeOf(cluster)]),
    );
    const mergeBlocks = partitionIntoSimilarityBlocks(
      clusters.map((cluster) => ({
        key: cluster.key,
        text: representativeByKey.get(cluster.key)!.extractedClaimText,
        weight: cluster.units.reduce((sum, unit) => sum + unit.length, 0),
      })),
      input.blockSize,
    );
    const outcomes = await pMap(
      mergeBlocks,
      async (keys) =>
        keys.length < 2
          ? undefined
          : input.call(keys.map((key) => representativeByKey.get(key)!)),
      { concurrency: input.concurrency },
    );

    const next: WorkingCluster[] = [];
    mergeBlocks.forEach((keys, blockIndex) => {
      const outcome = outcomes[blockIndex];
      const members = keys.map((key) => byKey.get(key)!);
      if (!outcome) {
        next.push(...members);
        return;
      }
      input.onExecution?.(outcome.execution);
      // The cluster key is its lowest claim-record ID, which is not always
      // its representative; the model sees representatives.
      const keyByRepresentative = new Map(
        keys.map((key) => [representativeByKey.get(key)!.claimRecordId, key]),
      );
      const representatives = keys.map((key) => representativeByKey.get(key)!);
      const repaired =
        outcome.status === "completed"
          ? repairClusterPartition(outcome.clusters, representatives)
          : undefined;
      const call: BlockedMergeCall = {
        ...callRecord(blockIndex, outcome, repaired?.repairNote),
        round,
      };
      const groups = repaired
        ? repaired.clusters.map((cluster) => ({
            canonicalClaim: cluster.canonicalClaim,
            keys: cluster.claimRecordIds.map(
              (claimRecordId) => keyByRepresentative.get(claimRecordId)!,
            ),
          }))
        : keys.map((key) => ({ canonicalClaim: undefined, keys: [key] }));
      for (const group of groups) {
        const joined = group.keys.map((key) => byKey.get(key)!);
        const unitsJoined = joined.flatMap((cluster) => cluster.units);
        const blocksJoined = new Map<number, BlockedClusteringCall>();
        for (const block of joined.flatMap((cluster) => cluster.blocks)) {
          blocksJoined.set(block.blockIndex, block);
        }
        const mergesJoined = new Map<string, BlockedMergeCall>();
        for (const merge of joined.flatMap((cluster) => cluster.merges)) {
          mergesJoined.set(
            `${String(merge.round)}:${String(merge.blockIndex)}`,
            merge,
          );
        }
        next.push({
          key: clusterKey(unitsJoined),
          // One cluster keeps the canonical claim its block wrote; a join
          // takes the merge request's description of what they share.
          canonicalClaim:
            joined.length > 1 && group.canonicalClaim
              ? collapseWhitespace(group.canonicalClaim)
              : joined[0]!.canonicalClaim,
          units: unitsJoined,
          blocks: [...blocksJoined.values()],
          merges: [...mergesJoined.values(), call],
        });
      }
    });

    // One request held every representative, or a round joined nothing and
    // the next would send the same requests again.
    if (mergeBlocks.length === 1 || next.length === clusters.length) {
      return next;
    }
    clusters = next;
  }
}
