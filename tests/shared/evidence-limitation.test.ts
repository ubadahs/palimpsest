import { describe, expect, it } from "vitest";

import { assessEvidenceLimitation } from "../../src/shared/evidence-limitation.js";

describe("assessEvidenceLimitation", () => {
  it("marks figure-only support when chunks omit the cited figure", () => {
    const result = assessEvidenceLimitation({
      claimTexts: ["Pvalb cells increase caudally (Figure 5)."],
      citingContext:
        "▶ Density rises caudally (Figure 5; Marlowe et al., 2021). ◀",
      selectedChunkTexts: [
        "Immunohistochemistry was performed on coronal sections.",
      ],
    });
    expect(result).toEqual({
      evidenceSufficiency: "limited",
      evidenceLimitation: "figure_only_support",
    });
  });

  it("keeps sufficiency when selected chunks mention the figure", () => {
    const result = assessEvidenceLimitation({
      claimTexts: ["Pvalb cells increase caudally (Figure 5)."],
      citingContext: "▶ Density rises caudally (Figure 5). ◀",
      selectedChunkTexts: [
        "Figure 5 shows a caudal increase in Pvalb+ cell density.",
      ],
    });
    expect(result).toEqual({ evidenceSufficiency: "sufficient" });
  });
});
