import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  serializeHandoffMap,
  type DiscoveryHandoffMap,
} from "../../src/domain/discovery-handoff.js";
import { loadPersistedDiscoveryHandoffs } from "../../src/pipeline/discovery-handoff-loader.js";

function makeHandoffs(): DiscoveryHandoffMap {
  return new Map([
    [
      "10.1234/seed",
      {
        doi: "10.1234/seed",
        resolvedPaper: {
          id: "seed-paper",
          doi: "10.1234/seed",
          title: "Seed paper",
          authors: ["Seed Author"],
          source: "openalex",
          fullTextHints: {
            providerAvailability: "available",
            repositoryUrl: "https://example.test/seed.xml",
          },
        },
        citingPapersRaw: [],
        mentionsByPaperId: new Map(),
        groundingByFamilyId: new Map(),
      },
    ],
  ]);
}

function serializedHandoffs(): string {
  const serialized = serializeHandoffMap(makeHandoffs());
  if (!serialized.ok) {
    throw new Error(serialized.error);
  }
  return serialized.data;
}

describe("loadPersistedDiscoveryHandoffs", () => {
  it("loads an existing validated handoff sidecar", () => {
    const directory = mkdtempSync(join(tmpdir(), "handoff-loader-"));
    const path = join(directory, "discovery-handoffs.json");
    try {
      writeFileSync(path, serializedHandoffs(), "utf8");

      const result = loadPersistedDiscoveryHandoffs(path, [
        "https://doi.org/10.1234/SEED",
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual(makeHandoffs());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a missing sidecar", () => {
    const directory = mkdtempSync(join(tmpdir(), "handoff-loader-"));
    try {
      const result = loadPersistedDiscoveryHandoffs(
        join(directory, "discovery-handoffs.json"),
        ["10.1234/seed"],
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(
          "Required persisted discovery handoff is missing",
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a fatal diagnostic for an existing malformed sidecar", () => {
    const directory = mkdtempSync(join(tmpdir(), "handoff-loader-"));
    const path = join(directory, "discovery-handoffs.json");
    try {
      writeFileSync(path, "{", "utf8");

      const result = loadPersistedDiscoveryHandoffs(path, ["10.1234/seed"]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(
          "Could not validate persisted discovery handoff",
        );
        expect(result.error).toContain("Invalid discovery handoff JSON");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a valid sidecar that omits a shortlisted seed DOI", () => {
    const directory = mkdtempSync(join(tmpdir(), "handoff-loader-"));
    const path = join(directory, "discovery-handoffs.json");
    try {
      writeFileSync(path, serializedHandoffs(), "utf8");

      const result = loadPersistedDiscoveryHandoffs(path, [
        "10.1234/seed",
        "10.1234/missing",
      ]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("is incomplete");
        expect(result.error).toContain("10.1234/missing");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a fatal diagnostic for tampered or unreadable sidecars", () => {
    const directory = mkdtempSync(join(tmpdir(), "handoff-loader-"));
    const tamperedPath = join(directory, "tampered.json");
    const unreadablePath = join(directory, "handoff-directory");
    try {
      const parsed = JSON.parse(serializedHandoffs()) as Record<
        string,
        unknown
      >;
      writeFileSync(
        tamperedPath,
        JSON.stringify({ ...parsed, contentHash: "0".repeat(64) }),
        "utf8",
      );
      mkdirSync(unreadablePath);

      const tampered = loadPersistedDiscoveryHandoffs(tamperedPath, [
        "10.1234/seed",
      ]);
      expect(tampered.ok).toBe(false);
      if (!tampered.ok) {
        expect(tampered.error).toMatch(/contentHash/);
      }

      const unreadable = loadPersistedDiscoveryHandoffs(unreadablePath, [
        "10.1234/seed",
      ]);
      expect(unreadable.ok).toBe(false);
      if (!unreadable.ok) {
        expect(unreadable.error).toContain(
          "Could not read persisted discovery handoff",
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
