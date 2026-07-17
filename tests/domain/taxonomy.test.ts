import { describe, expect, it } from "vitest";

import {
  auditabilityStatusSchema,
  citationFunctionValues,
  fidelityTopLabelSchema,
  supportedCitationFunction,
} from "../../src/domain/taxonomy.js";

describe("taxonomy", () => {
  it("locks down the in-scope citation function", () => {
    expect(supportedCitationFunction).toBe("empirical_attribution");
    expect(citationFunctionValues).toContain("empirical_attribution");
  });

  it("keeps the auditability and fidelity labels stable", () => {
    expect(auditabilityStatusSchema.parse("auditable_structured")).toBe(
      "auditable_structured",
    );
    expect(auditabilityStatusSchema.parse("auditable_pdf")).toBe(
      "auditable_pdf",
    );
    expect(fidelityTopLabelSchema.parse("D")).toBe("D");
  });
});
