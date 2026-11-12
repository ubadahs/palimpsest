import { describe, expect, it } from "vitest";

import type { DiscoverAttributedClaimRecord } from "../../src/contract/lean-artifacts.js";
import type { ModelExecution } from "../../src/contract/model-execution.js";
import { runLargeDiscover } from "./large-report.fixture.js";
import {
  CLAIM_CLUSTER_BLOCK_SIZE,
  clusterSeedClaims,
  partitionIntoSimilarityBlocks,
  type ClaimGroup,
  type ClusteringCall,
  type ClusteringCallOutcome,
} from "../../src/pipeline/claim-clustering.js";

const HASH = "a".repeat(64);

function execution(tag: string): ModelExecution {
  return {
    kind: "model",
    provider: "fixture",
    model: "fixture-model",
    promptId: "fixture-clustering",
    promptVersion: "v1",
    promptContentHash: `sha256:${HASH}`,
    requestHash: `sha256:${HASH}`,
    requestArtifact: {
      artifactId: `request-${tag}`,
      contentHash: `sha256:${HASH}`,
      role: "request",
    },
    responseArtifact: {
      artifactId: `response-${tag}`,
      contentHash: `sha256:${HASH}`,
      role: "response",
    },
  } as unknown as ModelExecution;
}

/**
 * Synthetic claims: each names one of `topics` findings with topic-specific
 * vocabulary, worded a few ways, and some are exact repeats.
 */
export function syntheticClaims(
  count: number,
  topics: number,
): DiscoverAttributedClaimRecord[] {
  const wordings = [
    (t: number) =>
      `Loss of gene${String(t)} reduced marker${String(t)} levels in tissue${String(t % 13)}`,
    (t: number) =>
      `gene${String(t)} knockdown lowers marker${String(t)} expression in tissue${String(t % 13)} cells`,
    (t: number) =>
      `The seed showed gene${String(t)} is required for marker${String(t)} in tissue${String(t % 13)}`,
  ];
  return Array.from({ length: count }, (_, index) => {
    const topic = (index * 7919) % topics;
    const wording = wordings[(index * 31) % 3]!;
    const repeat = index % 5 === 0 ? "" : ` (citer ${String(index)})`;
    return {
      claimRecordId: `claim-${String(index).padStart(5, "0")}-${String((index * 2654435761) % 997).padStart(3, "0")}`,
      seedId: "seed-1",
      mentionId: `mention-${String(index)}`,
      extractedClaimText: `${wording(topic)}${repeat}`,
    } as unknown as DiscoverAttributedClaimRecord;
  });
}

function topicOf(text: string): string {
  return /gene(\d+)/.exec(text)?.[1] ?? "none";
}

type FakeOptions = {
  /** Randomized delays shuffle completion order. */
  shuffle?: boolean;
  /** Request indexes (in send order is not stable, so by first claim) to fail. */
  failWhen?: (records: readonly DiscoverAttributedClaimRecord[]) => boolean;
  /** Drop the last claim from every reply, to force repair. */
  omitLast?: boolean;
};

/** A fake clustering model: groups claims by the gene they name. */
function fakeCall(options: FakeOptions = {}) {
  const sizes: number[] = [];
  let calls = 0;
  const call: ClusteringCall = async (records) => {
    calls += 1;
    sizes.push(records.length);
    if (options.shuffle) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.floor(Math.random() * 5)),
      );
    }
    const tag = records.map((record) => record.claimRecordId).join(",");
    if (options.failWhen?.(records)) {
      return {
        status: "failed",
        reason: "fixture failure",
        execution: execution(`fail-${tag.slice(0, 40)}`),
      } satisfies ClusteringCallOutcome;
    }
    const byTopic = new Map<string, string[]>();
    const listed = options.omitLast ? records.slice(0, -1) : records;
    for (const record of listed) {
      const topic = topicOf(record.extractedClaimText);
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), record.claimRecordId]);
    }
    return {
      status: "completed",
      clusters: [...byTopic.entries()].map(([topic, claimRecordIds]) => ({
        canonicalClaim: `gene${topic} controls marker${topic}`,
        claimRecordIds,
      })),
      execution: execution(tag.slice(0, 40)),
    } satisfies ClusteringCallOutcome;
  };
  return {
    call,
    sizes,
    get calls() {
      return calls;
    },
  };
}

function summarize(groups: readonly ClaimGroup[]) {
  return groups
    .map((group) => ({
      canonicalClaim: group.canonicalClaim,
      ids: group.records.map((record) => record.claimRecordId),
      equivalence: group.equivalence,
    }))
    .sort((left, right) => (left.ids[0]! < right.ids[0]! ? -1 : 1));
}

describe("blocked claim clustering", () => {
  it("keeps the single call when every claim fits one block", async () => {
    const records = syntheticClaims(40, 6);
    const fake = fakeCall();
    const groups = await clusterSeedClaims({
      records,
      call: fake.call,
      blockSize: 50,
    });
    expect(fake.calls).toBe(1);
    expect(fake.sizes).toEqual([40]);
    expect(groups.every((group) => group.equivalence.method === "model")).toBe(
      true,
    );
    expect(new Set(groups.map((group) => group.canonicalClaim)).size).toBe(6);
  });

  it("blocks, clusters, and merges into one family per finding", async () => {
    const records = syntheticClaims(1200, 40);
    const fake = fakeCall();
    const groups = await clusterSeedClaims({
      records,
      call: fake.call,
      blockSize: 60,
      concurrency: 4,
    });
    // Every block and merge request holds at most a block.
    expect(Math.max(...fake.sizes)).toBeLessThanOrEqual(60);
    // Blocks under half full were pooled: only a lone block may be smaller.
    expect(groups).toHaveLength(40);
    for (const group of groups) {
      const topics = new Set(
        group.records.map((record) => topicOf(record.extractedClaimText)),
      );
      expect(topics.size).toBe(1);
      expect(group.equivalence.method).toBe("blocked_model");
    }
    // Every claim lands in exactly one family.
    const ids = groups.flatMap((group) =>
      group.records.map((record) => record.claimRecordId),
    );
    expect(new Set(ids).size).toBe(records.length);
    expect(ids).toHaveLength(records.length);
    const merged = groups.find(
      (group) =>
        group.equivalence.method === "blocked_model" &&
        group.equivalence.blocks.length > 1,
    );
    expect(merged).toBeDefined();
    if (merged?.equivalence.method === "blocked_model") {
      expect(merged.equivalence.merges.length).toBeGreaterThan(0);
      expect(merged.equivalence.merges[0]!.round).toBe(1);
    }
  });

  it("forms the same families at any concurrency and completion order", async () => {
    const records = syntheticClaims(900, 30);
    const sequential = await clusterSeedClaims({
      records,
      call: fakeCall().call,
      blockSize: 50,
      concurrency: 1,
    });
    const parallel = await clusterSeedClaims({
      records: [...records].reverse(),
      call: fakeCall({ shuffle: true }).call,
      blockSize: 50,
      concurrency: 8,
    });
    expect(summarize(parallel)).toEqual(summarize(sequential));
  });

  it("merges in rounds when representatives exceed a block", async () => {
    // 120 findings over blocks of 20: representatives need several rounds.
    const records = syntheticClaims(1500, 120);
    const fake = fakeCall();
    const groups = await clusterSeedClaims({
      records,
      call: fake.call,
      blockSize: 20,
      concurrency: 3,
    });
    const rounds = new Set(
      groups.flatMap((group) =>
        group.equivalence.method === "blocked_model"
          ? group.equivalence.merges.map((merge) => merge.round)
          : [],
      ),
    );
    expect(Math.max(...rounds)).toBeGreaterThan(1);
    expect(Math.max(...fake.sizes)).toBeLessThanOrEqual(20);
    // Each family is still one finding.
    for (const group of groups) {
      expect(
        new Set(
          group.records.map((record) => topicOf(record.extractedClaimText)),
        ).size,
      ).toBe(1);
    }
  });

  it("repairs each block's partition and records the repair", async () => {
    const records = syntheticClaims(300, 10);
    const groups = await clusterSeedClaims({
      records,
      call: fakeCall({ omitLast: true }).call,
      blockSize: 40,
    });
    const ids = groups.flatMap((group) =>
      group.records.map((record) => record.claimRecordId),
    );
    expect(new Set(ids).size).toBe(records.length);
    const repaired = groups.filter(
      (group) =>
        group.equivalence.method === "blocked_model" &&
        group.equivalence.blocks.some(
          (block) => block.outcome === "model" && block.repairNote,
        ),
    );
    expect(repaired.length).toBeGreaterThan(0);
  });

  it("falls back to exact text inside a failed block only", async () => {
    const records = syntheticClaims(300, 10);
    const firstBlockClaims = new Set<string>();
    let failedOnce = false;
    const groups = await clusterSeedClaims({
      records,
      call: fakeCall({
        // Fail the block request holding the lowest claim id, not merges.
        failWhen: (batch) => {
          const hit =
            !failedOnce &&
            batch.some((record) =>
              record.claimRecordId.startsWith("claim-00000"),
            );
          if (hit) {
            failedOnce = true;
            for (const record of batch)
              firstBlockClaims.add(record.claimRecordId);
          }
          return hit;
        },
      }).call,
      blockSize: 40,
    });
    const fallbacks = groups.filter(
      (group) =>
        group.equivalence.method === "blocked_model" &&
        group.equivalence.blocks.some((block) => block.outcome === "fallback"),
    );
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const group of fallbacks) {
      if (group.equivalence.method !== "blocked_model") continue;
      const block = group.equivalence.blocks.find(
        (entry) => entry.outcome === "fallback",
      );
      expect(block?.outcome === "fallback" && block.fallbackReason).toBe(
        "fixture failure",
      );
    }
    // Other blocks were still clustered by the model.
    expect(
      groups.some(
        (group) =>
          group.equivalence.method === "blocked_model" &&
          group.equivalence.blocks.every((block) => block.outcome === "model"),
      ),
    ).toBe(true);
    // The merge pass still joins the fallback block's units by finding.
    for (const group of groups) {
      expect(
        new Set(
          group.records.map((record) => topicOf(record.extractedClaimText)),
        ).size,
      ).toBe(1);
    }
    expect(groups).toHaveLength(10);
  });

  it("splits similar items into bounded, deterministic blocks", () => {
    const items = Array.from({ length: 500 }, (_, index) => ({
      key: `k${String(index).padStart(4, "0")}`,
      text: `alpha${String(index % 25)} beta${String(index % 25)}`,
      weight: 1 + (index % 3),
    }));
    const blocks = partitionIntoSimilarityBlocks(items, 64);
    const again = partitionIntoSimilarityBlocks([...items].reverse(), 64);
    expect(again).toEqual(blocks);
    expect(blocks.flat().sort()).toEqual(items.map((item) => item.key).sort());
    blocks.forEach((block, blockIndex) => {
      expect(block.length).toBeLessThanOrEqual(64);
      if (blockIndex < blocks.length - 1) {
        expect(block.length).toBeGreaterThanOrEqual(32);
      }
    });
    // Similar items share blocks: each topic sits in one block.
    const blockOfTopic = new Map<number, Set<number>>();
    blocks.forEach((block, blockIndex) => {
      for (const key of block) {
        const topic = Number(key.slice(1)) % 25;
        blockOfTopic.set(
          topic,
          (blockOfTopic.get(topic) ?? new Set()).add(blockIndex),
        );
      }
    });
    expect([...blockOfTopic.values()].every((set) => set.size === 1)).toBe(
      true,
    );
  });
});

describe("blocked claim clustering in Discover", () => {
  it("writes blocked families the artifact contract accepts, the same at any concurrency", async () => {
    const sizes: number[] = [];
    const run = (concurrency: number) =>
      runLargeDiscover({
        citingPapers: 400,
        families: 30,
        concurrency,
        onClusteringCall: (claims) => sizes.push(claims),
      });
    const sequential = await run(1);
    const parallel = await run(8);
    const candidates = sequential.payload.claimCandidates;
    expect(sequential.payload.attributedClaimRecords).toHaveLength(800);
    expect(candidates).toHaveLength(30);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(CLAIM_CLUSTER_BLOCK_SIZE);
    for (const candidate of candidates) {
      expect(candidate.equivalence?.method).toBe("blocked_model");
    }
    // Census selection keeps every family and probes every citer.
    expect(
      sequential.payload.candidateDispositions.every(
        (disposition) => disposition.selectedForScope,
      ),
    ).toBe(true);
    expect(
      sequential.payload.citingPapers.every(
        (paper) => paper.probe.status === "selected",
      ),
    ).toBe(true);
    expect(parallel.payload).toEqual(sequential.payload);
  }, 60_000);
});
