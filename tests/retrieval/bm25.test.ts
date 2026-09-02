import { describe, expect, it } from "vitest";

import {
  buildBm25Index,
  rankBm25Index,
  rankDocumentsByBm25Detailed,
  tokenizeBm25Text,
} from "../../src/retrieval/bm25.js";

type TestDocument = {
  id: string;
  text: string;
};

describe("tokenizeBm25Text", () => {
  it("keeps greek letters and hyphenated compounds intact", () => {
    expect(tokenizeBm25Text("β-catenin and γ-catenin")).toEqual([
      "β-catenin",
      "γ-catenin",
    ]);
    expect(tokenizeBm25Text("10 μM")).toEqual(["10", "μm"]);
  });

  it("keeps decimals, short numbers, and figure references", () => {
    expect(
      tokenizeBm25Text("A 2.3-fold increase (p < 0.05) at day 7, Fig. 3C"),
    ).toEqual(["2.3-fold", "increase", "p", "0.05", "day", "7", "fig", "3c"]);
    expect(tokenizeBm25Text("the 5 mM treatment")).toEqual([
      "5",
      "mm",
      "treatment",
    ]);
  });

  it("folds simple plurals without touching -ss, -us, -is, or numerics", () => {
    expect(tokenizeBm25Text("neurons neuron cells cell")).toEqual([
      "neuron",
      "neuron",
      "cell",
      "cell",
    ]);
    expect(tokenizeBm25Text("class nucleus axis 3c")).toEqual([
      "class",
      "nucleus",
      "axis",
      "3c",
    ]);
  });
});

describe("rankDocumentsByBm25Detailed", () => {
  it("matches a numeric, greek-lettered claim to the passage that states it", () => {
    const documents: TestDocument[] = [
      {
        id: "intro",
        text: "Catenin family proteins regulate adhesion in many tissues.",
      },
      {
        id: "result",
        text: "β-catenin levels rose 2.3-fold after 10 μM treatment (Fig. 3C).",
      },
    ];
    const ranked = rankDocumentsByBm25Detailed(
      "β-catenin increased 2.3-fold at 10 μM",
      documents,
      (document) => document.text,
      (document) => document.id,
      2,
    );
    expect(ranked[0]?.document.id).toBe("result");
  });

  it("retains raw scores and breaks exact ties by document ID", () => {
    const documents: TestDocument[] = [
      { id: "chunk-z", text: "shared lexical evidence passage" },
      { id: "chunk-a", text: "shared lexical evidence passage" },
    ];
    const ranked = rankDocumentsByBm25Detailed(
      "shared lexical evidence",
      documents,
      (document) => document.text,
      (document) => document.id,
      10,
    );

    expect(ranked.map(({ document, rank }) => [document.id, rank])).toEqual([
      ["chunk-a", 1],
      ["chunk-z", 2],
    ]);
    expect(ranked[0]!.score).toBeGreaterThan(0);
    expect(ranked[1]!.score).toBe(ranked[0]!.score);
  });

  it("ranks identically from a prebuilt index", () => {
    const documents: TestDocument[] = [
      { id: "a", text: "Pvalb neurons in the ventral relay" },
      { id: "b", text: "Calb1 neurons in the interrelay leaflet" },
    ];
    const index = buildBm25Index(documents, (document) => document.text);
    const fromIndex = rankBm25Index(
      index,
      "Pvalb relay",
      (document) => document.id,
      2,
    );
    const direct = rankDocumentsByBm25Detailed(
      "Pvalb relay",
      documents,
      (document) => document.text,
      (document) => document.id,
      2,
    );
    expect(fromIndex).toEqual(direct);
    expect(fromIndex[0]?.document.id).toBe("a");
  });
});
