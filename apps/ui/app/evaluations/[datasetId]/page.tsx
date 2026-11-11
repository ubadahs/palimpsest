"use client";

import { use, useEffect, useState } from "react";

import { QueueCard } from "@/components/evaluation/queue-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  gradedCaseIds,
  TASKS,
  type DatasetView,
} from "@/lib/evaluation-client";
import { useStoredReviewer } from "@/lib/reviewer";
import { fetchJson, jsonPost } from "@/lib/utils";

import {
  ResultsView,
  revealedResultsSchema,
  type RevealedResults,
} from "./results-view";

type ExperimentSummary = {
  experimentId: string;
  success: number;
  planned: number;
  createdAt: string;
};

function Heading({ children }: { children: string }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
      {children}
    </h3>
  );
}

export default function DatasetPage({
  params,
}: {
  params: Promise<{ datasetId: string }>;
}) {
  const { datasetId } = use(params);
  const [view, setView] = useState<DatasetView | null>(null);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [results, setResults] = useState<RevealedResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useStoredReviewer();

  useEffect(() => {
    const base = `/api/evaluations/${datasetId}`;
    Promise.all([
      fetchJson<DatasetView>(base).then(setView),
      fetchJson<ExperimentSummary[]>(`${base}/experiments`).then(
        setExperiments,
      ),
    ]).catch((cause: unknown) => setError(String(cause)));
  }, [datasetId]);

  async function openResults(experimentId: string) {
    try {
      setResults(
        revealedResultsSchema.parse(
          await fetchJson(
            `/api/evaluations/${datasetId}/results`,
            jsonPost({ experimentId, reviewer }),
          ),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!view)
    return error ? (
      <p role="alert">{error}</p>
    ) : (
      <p className="text-sm text-[var(--text-muted)]">Loading…</p>
    );

  const graded = gradedCaseIds(view.annotations, reviewer);
  const done = (caseIds: readonly string[]) =>
    caseIds.filter((caseId) => graded.has(caseId)).length;
  const gradeHref = (query: string) =>
    `/evaluations/${datasetId}/grade?${query}`;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-[var(--font-instrument)] text-3xl tracking-[-0.03em]">
            {view.name}
          </h2>
          <p className="text-xs text-[var(--text-muted)]">{datasetId}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          Reviewer
          <Input
            className="h-9 w-40 rounded-full"
            onChange={(event) => setReviewer(event.target.value)}
            placeholder="Your name"
            value={reviewer}
          />
        </label>
      </header>

      {view.requests.length ? (
        <section className="space-y-3">
          <Heading>Waiting for you</Heading>
          {view.requests.toReversed().map((request) => (
            <QueueCard
              done={done(request.caseIds)}
              href={gradeHref(`request=${request.requestId}`)}
              key={request.requestId}
              purpose={request.purpose}
              title={request.title}
              total={request.caseIds.length}
            />
          ))}
        </section>
      ) : null}

      <section className="space-y-3">
        <Heading>Grade everything of one kind</Heading>
        <div className="grid gap-3 xl:grid-cols-2">
          {TASKS.map(({ task, name, question }) => {
            const caseIds = view.cases
              .filter((item) => item.task === task)
              .map((item) => item.caseId);
            return (
              <QueueCard
                done={done(caseIds)}
                href={gradeHref(`task=${task}`)}
                key={task}
                purpose={question}
                title={name}
                total={caseIds.length}
              />
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <Heading>Experiments</Heading>
        {experiments.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            None yet. Start one from the command line with <code>eval run</code>
            .
          </p>
        ) : null}
        {experiments.map((experiment) => (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-[var(--border)] bg-white px-5 py-3 text-sm"
            key={experiment.experimentId}
          >
            <span className="min-w-0 break-all">
              {experiment.experimentId}
              <span className="text-[var(--text-muted)]">
                {" "}
                · {experiment.success} of {experiment.planned} trials succeeded
              </span>
            </span>
            <Button
              disabled={reviewer.trim() === ""}
              onClick={() => void openResults(experiment.experimentId)}
              size="sm"
              title="Shows model answers. Labels you save on these cases afterwards are marked as not blind."
              variant="secondary"
            >
              Open results
            </Button>
          </div>
        ))}
        {error ? (
          <p className="text-sm text-[var(--danger)]" role="alert">
            {error}
          </p>
        ) : null}
        {results ? <ResultsView value={results} /> : null}
      </section>
    </div>
  );
}
