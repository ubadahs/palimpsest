import { describe, expect, it } from "vitest";

import {
  CITATION_ROLE_DEFINITIONS,
  citationRoleRubric,
  rubricCriteria,
  VERDICT_DEFINITIONS,
  verdictDefinitionsOnly,
  verdictRubric,
} from "../../src/domain/rubric.js";

describe("rubric", () => {
  it("puts every role and verdict definition into the production prompt sections", () => {
    for (const definition of Object.values(CITATION_ROLE_DEFINITIONS)) {
      expect(citationRoleRubric()).toContain(definition);
    }
    for (const { definition } of Object.values(VERDICT_DEFINITIONS)) {
      expect(verdictRubric()).toContain(definition);
    }
  });

  it("gives question-style providers the same definitions as sentences", () => {
    const criteria = rubricCriteria(verdictDefinitionsOnly());
    expect(Object.keys(criteria)).toEqual(["F", "D", "E", "U"]);
    expect(criteria.D).toBe(
      "A real source kernel exists, but scope, strength, certainty, causality, population, conditions, measurement endpoint, or generality is materially altered.",
    );
    expect(rubricCriteria(CITATION_ROLE_DEFINITIONS).unclear).toBe(
      "The context genuinely does not say which of the above it is.",
    );
  });
});
