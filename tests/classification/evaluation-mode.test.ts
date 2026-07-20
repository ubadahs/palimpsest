import { describe, expect, it } from "vitest";

import { deriveEvaluationMode } from "../../src/classification/evaluation-mode.js";

describe("deriveEvaluationMode", () => {
  it("keeps unclear roles in the manual-review queue instead of model paths", () => {
    expect(
      deriveEvaluationMode(
        "unclear",
        { isBundled: false, isReviewMediated: false },
        "medium",
      ),
    ).toBe("manual_review_role_ambiguous");
    expect(
      deriveEvaluationMode(
        "unclear",
        { isBundled: true, isReviewMediated: false, bundleSize: 3 },
        "medium",
      ),
    ).toBe("manual_review_role_ambiguous");
    expect(
      deriveEvaluationMode(
        "unclear",
        { isBundled: false, isReviewMediated: false },
        "low",
      ),
    ).toBe("manual_review_extraction_limited");
  });

  it("does not treat clear bundled attributions as ambiguous", () => {
    expect(
      deriveEvaluationMode(
        "substantive_attribution",
        { isBundled: true, isReviewMediated: false, bundleSize: 3 },
        "medium",
      ),
    ).toBe("fidelity_bundled_use");
    expect(
      deriveEvaluationMode(
        "background_context",
        { isBundled: true, isReviewMediated: false, bundleSize: 2 },
        "high",
      ),
    ).toBe("fidelity_bundled_use");
  });

  it("preserves review-mediated and low-information modes", () => {
    expect(
      deriveEvaluationMode(
        "substantive_attribution",
        { isBundled: false, isReviewMediated: true },
        "high",
      ),
    ).toBe("review_transmission");
    expect(
      deriveEvaluationMode(
        "acknowledgment_or_low_information",
        { isBundled: false, isReviewMediated: false },
        "low",
      ),
    ).toBe("skip_low_information");
  });
});
