"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Summary = {
  datasetId: string;
  name: string;
  sources: { runId: string }[];
  counts: Record<string, number>;
};

export default function EvaluationsPage() {
  const [datasets, setDatasets] = useState<Summary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch("/api/evaluations")
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        setDatasets((await response.json()) as Summary[]);
      })
      .catch((cause: unknown) => setError(String(cause)));
  }, []);
  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-[var(--font-instrument)] text-3xl">Evaluations</h2>
        <p className="text-sm text-[var(--text-muted)]">
          Frozen cases, blind annotation, and saved experiment results.
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
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {dataset.datasetId}
            </p>
            <p className="mt-2 text-sm">
              {Object.entries(dataset.counts)
                .map(([task, count]) => `${task}: ${count}`)
                .join(" · ")}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
