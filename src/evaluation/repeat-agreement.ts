/**
 * Run-to-run noise. A model asked the same case twice does not always give
 * the same answer, and a difference between two providers that is smaller
 * than that disagreement tells us nothing.
 */
import type { Trial } from "./runner.js";

export type RepeatAgreement = {
  providerId: string;
  task: "role" | "adjudication";
  /** Cases answered in more than one repetition. */
  repeatedCases: number;
  /** Repeated cases where every repetition gave the same answer. */
  sameAnswer: number;
};

export function repeatAgreement(
  trials: readonly Trial[],
  providerIds: readonly string[],
): RepeatAgreement[] {
  return providerIds.flatMap((providerId) =>
    (["role", "adjudication"] as const).flatMap((task) => {
      const answersByCase = new Map<string, string[]>();
      for (const trial of trials) {
        if (
          trial.providerId !== providerId ||
          trial.task !== task ||
          trial.status !== "success"
        )
          continue;
        const answers = answersByCase.get(trial.caseId) ?? [];
        answers.push(JSON.stringify(trial.prediction));
        answersByCase.set(trial.caseId, answers);
      }
      const repeated = [...answersByCase.values()].filter(
        (answers) => answers.length > 1,
      );
      return repeated.length === 0
        ? []
        : [
            {
              providerId,
              task,
              repeatedCases: repeated.length,
              sameAnswer: repeated.filter(
                (answers) => new Set(answers).size === 1,
              ).length,
            },
          ];
    }),
  );
}

export function repeatAgreementMarkdown(
  rows: readonly RepeatAgreement[],
): string[] {
  if (rows.length === 0) return [];
  return [
    "## Repeat agreement",
    "",
    "The same provider asked the same case again. A difference between providers smaller than this disagreement is noise.",
    "",
    "| Provider | Task | Same answer / repeated cases |",
    "|---|---|---:|",
    ...rows.map(
      (row) =>
        `| ${row.providerId} | ${row.task} | ${row.sameAnswer}/${row.repeatedCases} |`,
    ),
    "",
  ];
}
