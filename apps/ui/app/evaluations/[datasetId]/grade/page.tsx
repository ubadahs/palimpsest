"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";

import { Grader } from "@/components/evaluation/grader";
import { resolveQueue, type DatasetView } from "@/lib/evaluation-client";
import { useStoredReviewer } from "@/lib/reviewer";
import { fetchJson } from "@/lib/utils";

export default function GradePage({
  params,
  searchParams,
}: {
  params: Promise<{ datasetId: string }>;
  searchParams: Promise<{ request?: string; task?: string }>;
}) {
  const { datasetId } = use(params);
  const { request, task } = use(searchParams);
  const [view, setView] = useState<DatasetView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useStoredReviewer();

  const refresh = useCallback(async () => {
    setView(await fetchJson<DatasetView>(`/api/evaluations/${datasetId}`));
  }, [datasetId]);
  useEffect(() => {
    refresh().catch((cause: unknown) => setError(String(cause)));
  }, [refresh]);

  const queue = useMemo(
    () => (view ? resolveQueue(view, { request, task }) : undefined),
    [view, request, task],
  );

  if (error) return <p role="alert">{error}</p>;
  if (!view)
    return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  if (!queue)
    return (
      <p className="text-sm">
        This link names nothing to grade.{" "}
        <Link className="underline" href={`/evaluations/${datasetId}`}>
          Back to the dataset
        </Link>
      </p>
    );
  return (
    <Grader
      onReviewerChange={setReviewer}
      onSaved={refresh}
      queue={queue}
      reviewer={reviewer}
      view={view}
    />
  );
}
