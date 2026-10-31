"use client";

import { useMemo, useState } from "react";
import { z } from "zod";

const comparisonSchema = z.object({
  caseId: z.string(),
  task: z.enum(["role", "rerank"]),
  left: z.string(),
  right: z.string(),
  leftRole: z.string().nullable(),
  rightRole: z.string().nullable(),
  comparisonType: z.enum(["variant", "historical_baseline"]),
  scientificInputCompatible: z.boolean(),
  historicalCaseId: z.string().nullable(),
  roleAgreement: z.boolean().nullable(),
  substantiveAttributionDisagreement: z.boolean().nullable(),
  top5OverlapBeforePins: z.number().nullable(),
  top5OverlapAfterPins: z.number().nullable(),
});
const variantSchema = z.object({
  variantId: z.string(),
  task: z.string(),
  layout: z.string(),
  phase: z.string(),
  batchSize: z.number().nullable(),
  selectedCases: z.number(),
  completedCases: z.number(),
  plannedRequests: z.number(),
  logicalRequestsStarted: z.number(),
  firstAttemptSuccess: z.number(),
  eventualRequestSuccess: z.number(),
  attempts: z.number(),
  requestP50Ms: z.number().nullable(),
  requestP95Ms: z.number().nullable(),
  achievedConcurrency: z.number(),
  knownNewSpendUsd: z.number(),
  unknownChargeAttempts: z.number(),
  blindHumanRoleAccuracy: z.number().nullable(),
  blindHumanRoleDenominator: z.number(),
  exposedHumanRoleDenominator: z.number(),
  blindHumanRerankNdcg5: z.number().nullable(),
  blindHumanRerankPinnedNdcg5: z.number().nullable(),
  blindHumanRerankDenominator: z.number(),
  exposedHumanRerankDenominator: z.number(),
  repeatability: z.number().nullable(),
  repeatabilityPairedCases: z.number(),
});
const resultSchema = z.object({
  caseId: z.string(),
  variantId: z.string(),
  requestId: z.string(),
  role: z.string().optional(),
  roleConfidence: z.number().optional(),
  roleProbabilities: z.record(z.string(), z.number()).optional(),
  scores: z
    .record(
      z.string(),
      z.object({
        score: z.number(),
        confidence: z.number().optional(),
        probabilities: z.record(z.string(), z.number()).optional(),
      }),
    )
    .optional(),
});
export const revealedResultsSchema = z.object({
  trials: z.array(
    z
      .object({
        trialId: z.string(),
        caseId: z.string(),
        task: z.string(),
        providerId: z.string(),
        variantId: z.string().optional(),
        status: z.string(),
        prediction: z.unknown().optional(),
      })
      .passthrough(),
  ),
  optimizationResults: z.array(resultSchema).default([]),
  report: z
    .object({
      reportId: z.string(),
      caveat: z.string(),
      optimization: z
        .object({
          operations: z.object({
            plannedRequests: z.number(),
            attempts: z.number(),
            completedResults: z.number(),
            unknownCompletionAttempts: z.number(),
            rateLimitResponses: z.number(),
          }),
          cost: z.object({
            knownNewSpendUsd: z.number(),
            unknownChargeAttempts: z.number(),
            historicalUniqueAttempts: z.number(),
            historicalMissingTelemetryTrials: z.number(),
            knownHistoricalSpendUsd: z.number(),
            unknownHistoricalChargeAttempts: z.number(),
          }),
          variants: z.array(variantSchema),
          baselines: z.array(
            z
              .object({
                experimentId: z.string(),
                providerId: z.string(),
                model: z.string(),
                historicalThinking: z.string().nullable(),
                historicalExperimentIds: z.array(z.string()),
                selectedReferenceAttempts: z.number(),
                selectedReferenceUnknownChargeAttempts: z.number(),
                accounting: z
                  .object({ uniqueAttempts: z.number() })
                  .passthrough(),
                unknownHistoricalChargeAttempts: z.number(),
              })
              .passthrough(),
          ),
          comparisons: z.array(comparisonSchema),
          operationalRecommendations: z.array(
            z.object({
              task: z.string(),
              status: z.string(),
              variantId: z.string().nullable(),
              basis: z.string(),
            }),
          ),
          humanEvaluationShortlist: z.array(
            z.object({
              caseId: z.string(),
              task: z.string(),
              priority: z.number(),
              rationale: z.string(),
            }),
          ),
          interpretation: z.string(),
        })
        .nullable()
        .optional(),
    })
    .passthrough()
    .nullable(),
});
export type RevealedResults = z.infer<typeof revealedResultsSchema>;

function milliseconds(value: number | null): string {
  return value == null ? "—" : Math.round(value).toLocaleString();
}

export function ResultsView({ value }: { value: RevealedResults }) {
  const [showAll, setShowAll] = useState(false);
  const [caseId, setCaseId] = useState("");
  const analysis = value.report?.optimization;
  const disagreements = useMemo(
    () =>
      analysis?.comparisons.filter(
        (row) =>
          row.roleAgreement === false ||
          (row.top5OverlapBeforePins != null && row.top5OverlapBeforePins < 1),
      ) ?? [],
    [analysis],
  );
  const rows = showAll ? (analysis?.comparisons ?? []) : disagreements;
  const selected = rows.find((row) => row.caseId === caseId);
  const details = value.optimizationResults.filter(
    (result) => result.caseId === caseId,
  );

  return (
    <div className="mt-4 space-y-4 text-sm">
      <p className="rounded border p-3">
        {value.report?.caveat ?? "No report generated yet."}
      </p>
      {analysis ? (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded border p-3">
              <h4 className="font-semibold">Operations</h4>
              <p>
                {analysis.operations.completedResults}/
                {analysis.operations.plannedRequests} planned requests validated
                from {analysis.operations.attempts} HTTP attempts
              </p>
              <p>
                {analysis.operations.unknownCompletionAttempts} attempts with
                uncertain completion; {analysis.operations.rateLimitResponses}{" "}
                rate limits
              </p>
            </div>
            <div className="rounded border p-3">
              <h4 className="font-semibold">Cost and provenance</h4>
              <p>
                ${analysis.cost.knownNewSpendUsd.toFixed(4)} known new spend;{" "}
                {analysis.cost.unknownChargeAttempts} attempts with unknown
                charges
              </p>
              <p>
                {analysis.cost.historicalUniqueAttempts} unique recorded
                historical attempts;{" "}
                {analysis.cost.historicalMissingTelemetryTrials} source trials
                missing attempt telemetry
              </p>
              <p>
                ${analysis.cost.knownHistoricalSpendUsd.toFixed(4)} known
                historical spend;{" "}
                {analysis.cost.unknownHistoricalChargeAttempts} historical
                attempts with unknown charges
              </p>
              {analysis.baselines.map((item) => (
                <p
                  key={`${item.experimentId}/${item.providerId}`}
                  className="text-xs text-[var(--text-muted)]"
                >
                  {item.providerId} · {item.model} ·{" "}
                  {item.historicalThinking ??
                    "saved thinking settings in report"}{" "}
                  · selected {item.selectedReferenceAttempts} attempts /{" "}
                  {item.selectedReferenceUnknownChargeAttempts} unknown usage ·
                  cumulative originals {item.accounting.uniqueAttempts} /{" "}
                  {item.unknownHistoricalChargeAttempts} unknown usage across{" "}
                  {item.historicalExperimentIds.length} experiments
                </p>
              ))}
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {analysis.operationalRecommendations.map((item) => (
              <div className="rounded border p-3" key={item.task}>
                <h4 className="font-semibold">
                  {item.task} operational recommendation
                </h4>
                <p>{item.variantId ?? "Pending measured coverage"}</p>
                <p className="text-xs text-[var(--text-muted)]">{item.basis}</p>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto rounded border">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-[var(--panel-muted)]">
                <tr>
                  <th className="p-2">Variant</th>
                  <th className="p-2">Cases</th>
                  <th className="p-2">Request success</th>
                  <th className="p-2">Attempts</th>
                  <th className="p-2">Request p50 / p95 ms</th>
                  <th className="p-2">Peak concurrent</th>
                  <th className="p-2">Repeatability</th>
                  <th className="p-2">Blind human quality</th>
                </tr>
              </thead>
              <tbody>
                {analysis.variants.map((variant) => (
                  <tr className="border-t" key={variant.variantId}>
                    <td className="p-2">
                      <strong>{variant.variantId}</strong>
                      <br />
                      {variant.task} · {variant.layout} · {variant.phase}
                      {variant.batchSize ? ` · batch ${variant.batchSize}` : ""}
                    </td>
                    <td className="p-2">
                      {variant.completedCases}/{variant.selectedCases}
                    </td>
                    <td className="p-2">
                      first {variant.firstAttemptSuccess}/
                      {variant.plannedRequests}
                      <br />
                      eventual {variant.eventualRequestSuccess}/
                      {variant.plannedRequests}
                    </td>
                    <td className="p-2">{variant.attempts}</td>
                    <td className="p-2">
                      {milliseconds(variant.requestP50Ms)} /{" "}
                      {milliseconds(variant.requestP95Ms)}
                    </td>
                    <td className="p-2">{variant.achievedConcurrency}</td>
                    <td className="p-2">
                      {variant.repeatability?.toFixed(2) ?? "—"} (n=
                      {variant.repeatabilityPairedCases})
                    </td>
                    <td className="p-2">
                      {variant.task === "role" ? (
                        <>
                          {variant.blindHumanRoleAccuracy == null
                            ? "Unlabeled"
                            : `${(variant.blindHumanRoleAccuracy * 100).toFixed(1)}%`}{" "}
                          (n={variant.blindHumanRoleDenominator}; exposed{" "}
                          {variant.exposedHumanRoleDenominator})
                        </>
                      ) : (
                        <>
                          NDCG@5{" "}
                          {variant.blindHumanRerankNdcg5?.toFixed(2) ??
                            "unlabeled"}
                          ; pinned{" "}
                          {variant.blindHumanRerankPinnedNdcg5?.toFixed(2) ??
                            "unlabeled"}{" "}
                          (n={variant.blindHumanRerankDenominator}; exposed{" "}
                          {variant.exposedHumanRerankDenominator})
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <section>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-semibold">
                Variant comparisons and disagreements
              </h4>
              <label>
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(event) => setShowAll(event.target.checked)}
                />{" "}
                Show all {analysis.comparisons.length} paired cases
              </label>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              {disagreements.length} diagnostic disagreements. Ranking overlap
              is shown before and after grounding pins.
            </p>
            <div className="max-h-64 overflow-auto rounded border">
              {rows.map((row, index) => (
                <button
                  key={`${row.caseId}-${row.left}-${row.right}-${index}`}
                  className="block w-full border-b p-2 text-left hover:bg-[var(--panel-muted)]"
                  onClick={() => setCaseId(row.caseId)}
                >
                  {row.caseId} · {row.left} / {row.right} ·{" "}
                  {row.comparisonType === "historical_baseline"
                    ? "historical"
                    : "variant"}
                  {row.scientificInputCompatible ? "" : " · changed inputs"} ·{" "}
                  {row.task === "role"
                    ? `${row.leftRole ?? "?"} / ${row.rightRole ?? "?"}`
                    : `top 5 overlap ${row.top5OverlapBeforePins?.toFixed(2) ?? "?"} → ${row.top5OverlapAfterPins?.toFixed(2) ?? "?"}`}
                </button>
              ))}
              {!rows.length ? (
                <p className="p-3 text-[var(--text-muted)]">
                  No paired observations in this view.
                </p>
              ) : null}
            </div>
          </section>
          <details className="rounded border p-3">
            <summary>
              Human evaluation shortlist (
              {analysis.humanEvaluationShortlist.length})
            </summary>
            <ul className="mt-2 space-y-1 text-xs">
              {analysis.humanEvaluationShortlist.map((item) => (
                <li key={item.caseId}>
                  {item.caseId} · {item.task} · {item.rationale}
                </li>
              ))}
            </ul>
          </details>
          {selected ? (
            <section className="rounded border p-3">
              <h4 className="font-semibold">{selected.caseId}</h4>
              <p className="text-xs text-[var(--text-muted)]">
                Provider confidence, answer probabilities, and repeated-answer
                stability are separate diagnostics.
              </p>
              {details.length ? (
                details.map((result) => (
                  <details
                    key={result.requestId}
                    className="mt-2 rounded border p-2"
                  >
                    <summary>
                      {result.variantId} · {result.requestId}
                    </summary>
                    <pre className="mt-2 overflow-auto text-xs">
                      {JSON.stringify(
                        {
                          role: result.role,
                          roleConfidence: result.roleConfidence,
                          roleProbabilities: result.roleProbabilities,
                          passageScores: result.scores,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ))
              ) : (
                <p>No request-level result saved for this case.</p>
              )}
            </section>
          ) : null}
          <p className="text-xs text-[var(--text-muted)]">
            {analysis.interpretation}
          </p>
        </>
      ) : (
        <details>
          <summary>Saved trials</summary>
          <pre className="max-h-96 overflow-auto rounded border p-3 text-xs">
            {JSON.stringify(value.trials, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
