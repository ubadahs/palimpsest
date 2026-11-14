import { describe, expect, it } from "vitest";

import { deriveEvaluationMode } from "../../../src/stages/prepare/evaluation-mode.js";

describe("deriveEvaluationMode", () => {
  it("sends every unclear role to the role-ambiguous queue the role model reads", () => {
    expect(
      deriveEvaluationMode("unclear", {
        isBundled: false,
        isReviewMediated: false,
      }),
    ).toBe("manual_review_role_ambiguous");
    expect(
      deriveEvaluationMode("unclear", {
        isBundled: true,
        isReviewMediated: false,
        bundleSize: 3,
      }),
    ).toBe("manual_review_role_ambiguous");
  });

  it("does not treat clear bundled attributions as ambiguous", () => {
    expect(
      deriveEvaluationMode("substantive_attribution", {
        isBundled: true,
        isReviewMediated: false,
        bundleSize: 3,
      }),
    ).toBe("fidelity_bundled_use");
    expect(
      deriveEvaluationMode("background_context", {
        isBundled: true,
        isReviewMediated: false,
        bundleSize: 2,
      }),
    ).toBe("fidelity_bundled_use");
  });

  it("preserves review-mediated and low-information modes", () => {
    expect(
      deriveEvaluationMode("substantive_attribution", {
        isBundled: false,
        isReviewMediated: true,
      }),
    ).toBe("review_transmission");
    expect(
      deriveEvaluationMode("acknowledgment_or_low_information", {
        isBundled: false,
        isReviewMediated: false,
      }),
    ).toBe("skip_low_information");
  });
});
