"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { TASKS } from "@/lib/evaluation-client";
import { fetchJson } from "@/lib/utils";

type Summary = {
  datasetId: string;
  name: string;
  sources: { runId: string }[];
  openRequests: number;
  counts: Record<string, number>;
};

export default function EvaluationsPage() {
  const [datasets, setDatasets] = useState<Summary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    // Datasets with a request waiting come first.
    fetchJson<Summary[]>("/api/evaluations")
      .then((all) =>
        setDatasets(
          all.toSorted((left, right) => right.openRequests - left.openRequests),
        ),
      )
      .catch((cause: unknown) => setError(String(cause)));
  }, []);
  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-[var(--font-instrument)] text-3xl">Evaluations</h2>
        <p className="text-sm text-[var(--text-muted)]">
          Frozen cases to grade blind, and saved experiment results.
        </p>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {datasets.length === 0 ? (
        <p>
          No frozen datasets yet. Create one with{" "}
          <code>
            npm run dev -- eval dataset --report &lt;path&gt; --name
            &lt;name&gt;
          </code>
          .
        </p>
      ) : null}
      <div className="grid gap-3">
        {datasets.map((dataset) => (
          <Link
            className="rounded-xl border border-[var(--border)] bg-white p-5 hover:bg-[var(--panel-muted)]"
            key={dataset.datasetId}
            href={`/evaluations/${dataset.datasetId}`}
          >
            <strong>{dataset.name}</strong>
            {dataset.openRequests ? (
              <span className="ml-3 rounded-full bg-[var(--accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--accent)]">
                {dataset.openRequests === 1
                  ? "1 request waiting for you"
                  : `${String(dataset.openRequests)} requests waiting for you`}
              </span>
            ) : null}
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {dataset.datasetId}
            </p>
            <p className="mt-2 text-sm">
              {TASKS.map(
                ({ task, name }) =>
                  `${String(dataset.counts[task] ?? 0)} ${name.toLowerCase()}`,
              ).join(" · ")}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
