import { describe, expect, it } from "vitest";

import {
  repeatAgreement,
  repeatAgreementMarkdown,
} from "../../src/evaluation/repeat-agreement.js";
import type { Trial } from "../../src/evaluation/runner.js";

function trial(
  providerId: string,
  caseId: string,
  verdict: string,
  repetition: number,
  status: Trial["status"] = "success",
): Trial {
  return {
    trialId: `${providerId}-${caseId}-${String(repetition)}`,
    experimentId: "experiment",
    caseId,
    task: "adjudication",
    providerId,
    requestedModel: "model",
    repetition,
    caseHash: "case",
    providerHash: "provider",
    status,
    prediction: { verdict },
    calls: [],
  };
}

describe("repeat agreement", () => {
  it("counts the cases a provider answered the same way every time", () => {
    const rows = repeatAgreement(
      [
        trial("steady", "case_a", "F", 1),
        trial("steady", "case_a", "F", 2),
        trial("steady", "case_b", "D", 1),
        trial("steady", "case_b", "F", 2),
        trial("steady", "case_c", "F", 1),
        trial("steady", "case_c", "F", 2, "provider_failure"),
        trial("once", "case_a", "F", 1),
      ],
      ["steady", "once"],
    );
    expect(rows).toEqual([
      {
        providerId: "steady",
        task: "adjudication",
        repeatedCases: 2,
        sameAnswer: 1,
      },
    ]);
    expect(repeatAgreementMarkdown(rows).join("\n")).toContain(
      "| steady | adjudication | 1/2 |",
    );
  });

  it("says nothing when no case was asked twice", () => {
    expect(
      repeatAgreement([trial("once", "case_a", "F", 1)], ["once"]),
    ).toEqual([]);
    expect(repeatAgreementMarkdown([])).toEqual([]);
  });
});
