import { describe, expect, it } from "vitest";

import type { EvaluationMode } from "../../src/domain/types.js";
import { getRubric } from "../../src/classification/rubrics.js";

describe("getRubric", () => {
  const modes: EvaluationMode[] = [
    "fidelity_specific_claim",
    "fidelity_background_framing",
    "fidelity_bundled_use",
    "fidelity_methods_use",
    "review_transmission",
    "skip_low_information",
    "manual_review_role_ambiguous",
    "manual_review_extraction_limited",
  ];

  for (const mode of modes) {
    it(`returns a rubric for ${mode}`, () => {
      const rubric = getRubric(mode);
      expect(rubric.mode).toBe(mode);
      expect(rubric.question.length).toBeGreaterThan(10);
      expect(rubric.verdictOptions.length).toBeGreaterThanOrEqual(1);
    });
  }

  it("has different questions for different modes", () => {
    const specific = getRubric("fidelity_specific_claim");
    const background = getRubric("fidelity_background_framing");
    const methods = getRubric("fidelity_methods_use");
    const bundled = getRubric("fidelity_bundled_use");

    expect(specific.question).not.toBe(background.question);
    expect(methods.question).not.toBe(bundled.question);
  });

  it("specific claim rubric asks about evidence supporting finding", () => {
    const rubric = getRubric("fidelity_specific_claim");
    expect(rubric.question).toContain("specific");
    expect(rubric.verdictOptions).toContain("supported");
    expect(rubric.verdictOptions).toContain("not_supported");
  });

  it("bundled rubric asks about bundle membership on two dimensions", () => {
    const rubric = getRubric("fidelity_bundled_use");
    expect(rubric.question).toContain("bundle");
    expect(rubric.question).toContain("Topical relevance");
    expect(rubric.question).toContain("Propositional support");
    expect(rubric.verdictOptions).toContain("partially_supported");
  });
});
