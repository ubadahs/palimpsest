/**
 * Scores each provider on constructed cases, where the right verdict is known
 * because the case was made by editing a faithful restatement.
 */
import { z } from "zod";
import type { Trial } from "./runner.js";
import type { ConstructedLabel, EvaluationCase } from "./types.js";

type ConstructedCase = Extract<EvaluationCase, { task: "adjudication" }> & {
  constructed: ConstructedLabel;
};

type Tally = {
  /** Cases with a verdict from this provider. */
  scored: number;
  matchedExpectedVerdict: number;
  /** Distortions called `F`: the provider missed them. */
  falseFaithful: number;
};

export type ConstructedScore = {
  providerId: string;
  /** Edits that change the meaning; the expected verdict is `D` or `E`. */
  distortions: Tally & {
    cases: number;
    /** `D` verdicts on expected-`D` cases that name the mutation made. */
    namedMutationKind: number;
    /** Cases whose unedited source also has a verdict from this provider. */
    pairs: number;
    /** Pairs where the source was called `F` and the edit was not. */
    discriminatedPairs: number;
  };
  /**
   * The distortions whose chunks do not depend on the citing wording. A
   * provider reading chunks and one reading the whole paper are comparable
   * on these alone.
   */
  pinnedEvidence: Tally;
  byMutationKind: (Tally & { mutationKind: string })[];
  /** Edits that change only the wording; anything but `F` is a false alarm. */
  controls: { cases: number; scored: number; calledFaithful: number };
};

const verdictSchema = z.object({ verdict: z.string() });
const namedKindsSchema = z.object({
  response: z.object({ mutationKinds: z.array(z.string()) }),
});

function verdictOf(trial: Trial | undefined): string | undefined {
  const parsed = verdictSchema.safeParse(trial?.prediction);
  return trial?.status === "success" && parsed.success
    ? parsed.data.verdict
    : undefined;
}

function namedMutationKinds(trial: Trial): string[] {
  const parsed = namedKindsSchema.safeParse(trial.diagnostics);
  return parsed.success ? parsed.data.response.mutationKinds : [];
}

function isConstructed(item: EvaluationCase): item is ConstructedCase {
  return item.task === "adjudication" && item.constructed != null;
}

const emptyTally = (): Tally => ({
  scored: 0,
  matchedExpectedVerdict: 0,
  falseFaithful: 0,
});

function tally(target: Tally, verdict: string, expected: string): void {
  target.scored++;
  if (verdict === expected) target.matchedExpectedVerdict++;
  if (verdict === "F") target.falseFaithful++;
}

export function constructedCaseIds(
  cases: readonly EvaluationCase[],
): Set<string> {
  return new Set(cases.filter(isConstructed).map((item) => item.caseId));
}

export function scoreConstructedCases(
  cases: readonly EvaluationCase[],
  trials: readonly Trial[],
  providerIds: readonly string[],
): ConstructedScore[] {
  const constructed = cases.filter(isConstructed);
  if (constructed.length === 0) return [];
  const controlCases = constructed.filter(
    (item) => item.constructed.expectedVerdict === "F",
  ).length;
  return providerIds.flatMap((providerId) => {
    const trialByCase = new Map(
      trials
        .filter(
          (trial) =>
            trial.providerId === providerId &&
            trial.task === "adjudication" &&
            trial.repetition === 1,
        )
        .map((trial) => [trial.caseId, trial]),
    );
    if (trialByCase.size === 0) return [];
    const distortions = {
      ...emptyTally(),
      cases: constructed.length - controlCases,
      namedMutationKind: 0,
      pairs: 0,
      discriminatedPairs: 0,
    };
    const pinnedEvidence = emptyTally();
    const controls = { cases: controlCases, scored: 0, calledFaithful: 0 };
    const byKind = new Map<string, Tally>();
    for (const item of constructed) {
      const trial = trialByCase.get(item.caseId);
      const verdict = verdictOf(trial);
      if (!trial || verdict == null) continue;
      const label = item.constructed;
      if (label.expectedVerdict === "F") {
        controls.scored++;
        if (verdict === "F") controls.calledFaithful++;
        continue;
      }
      const kind = byKind.get(label.mutationKind) ?? emptyTally();
      byKind.set(label.mutationKind, kind);
      for (const target of [
        distortions,
        kind,
        ...(label.evidencePinned ? [pinnedEvidence] : []),
      ])
        tally(target, verdict, label.expectedVerdict);
      if (
        verdict === "D" &&
        label.expectedVerdict === "D" &&
        namedMutationKinds(trial).includes(label.mutationKind)
      )
        distortions.namedMutationKind++;
      const sourceVerdict = verdictOf(trialByCase.get(label.sourceCaseId));
      if (sourceVerdict != null) {
        distortions.pairs++;
        if (sourceVerdict === "F" && verdict !== "F")
          distortions.discriminatedPairs++;
      }
    }
    return [
      {
        providerId,
        distortions,
        pinnedEvidence,
        byMutationKind: [...byKind.entries()]
          .map(([mutationKind, counts]) => ({ mutationKind, ...counts }))
          .sort((left, right) =>
            left.mutationKind < right.mutationKind ? -1 : 1,
          ),
        controls,
      },
    ];
  });
}

export function constructedScoreMarkdown(
  scores: readonly ConstructedScore[],
): string[] {
  if (scores.length === 0) return [];
  return [
    "## Constructed cases",
    "",
    "Each case edits a restatement a human labelled faithful. A distortion changes its meaning in one named way, so the expected verdict is known and a provider that calls it faithful has missed it. A control changes only the wording; a provider that objects to one is reacting to the edit, not to the seed.",
    "",
    "| Provider | Distortions scored | Expected verdict | Called faithful | Named the mutation | Source F, edit not F | Controls called faithful |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...scores.map(
      ({ providerId, distortions, controls }) =>
        `| ${providerId} | ${distortions.scored}/${distortions.cases} | ${distortions.matchedExpectedVerdict} | ${distortions.falseFaithful} | ${distortions.namedMutationKind} | ${distortions.discriminatedPairs}/${distortions.pairs} | ${controls.calledFaithful}/${controls.scored} |`,
    ),
    "",
    "Providers that read chunks and providers that read the whole paper are comparable only where the chunks do not depend on the citing wording, which is where grounding pins fill the packet:",
    "",
    "| Provider | Distortions with pinned evidence | Expected verdict | Called faithful |",
    "|---|---:|---:|---:|",
    ...scores.map(
      ({ providerId, pinnedEvidence }) =>
        `| ${providerId} | ${pinnedEvidence.scored} | ${pinnedEvidence.matchedExpectedVerdict} | ${pinnedEvidence.falseFaithful} |`,
    ),
    "",
  ];
}
