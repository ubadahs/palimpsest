"use client";

import { z } from "zod";

/** What the reveal endpoint returns for one case. */
export type Revealed = {
  historical: unknown;
  predictions: unknown[];
};

const answerSchema = z.object({
  providerId: z.string(),
  prediction: z
    .object({ verdict: z.string().optional(), role: z.string().optional() })
    .optional(),
});
const historicalSchema = z.array(
  z.object({
    verdict: z.string().nullish(),
    classification: z
      .object({ citationRole: z.string().optional() })
      .optional(),
  }),
);

/**
 * The answers models gave to the case on screen: one line per provider, then
 * the run the dataset was frozen from. Shown only after the reviewer asks.
 */
export function ModelAnswers({ revealed }: { revealed: Revealed }) {
  const byProvider = new Map<string, string[]>();
  for (const trial of revealed.predictions) {
    const parsed = answerSchema.safeParse(trial);
    if (!parsed.success) continue;
    const { providerId, prediction } = parsed.data;
    const answers = byProvider.get(providerId) ?? [];
    answers.push(prediction?.verdict ?? prediction?.role ?? "no answer");
    byProvider.set(providerId, answers);
  }
  const historical = historicalSchema.safeParse(revealed.historical);
  const original = historical.success
    ? historical.data
        .map((entry) => entry.verdict ?? entry.classification?.citationRole)
        .filter((answer) => answer != null)
    : [];

  return (
    <div className="space-y-2 text-xs text-[var(--text-muted)]">
      <p className="font-semibold uppercase tracking-[0.18em]">
        What the models answered
      </p>
      {byProvider.size === 0 && original.length === 0 ? (
        <p>No model has answered this case yet.</p>
      ) : (
        <dl className="space-y-1">
          {[...byProvider].map(([providerId, answers]) => (
            <div className="flex justify-between gap-3" key={providerId}>
              <dt>{providerId}</dt>
              <dd className="font-semibold text-[var(--text)]">
                {answers.join(", ")}
              </dd>
            </div>
          ))}
          {original.length ? (
            <div className="flex justify-between gap-3">
              <dt>the original run</dt>
              <dd className="font-semibold text-[var(--text)]">
                {original.join(", ")}
              </dd>
            </div>
          ) : null}
        </dl>
      )}
    </div>
  );
}
