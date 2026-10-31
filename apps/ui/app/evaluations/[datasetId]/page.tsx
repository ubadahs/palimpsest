"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import type {
  AnnotationEvent,
  BlindEvaluationCase,
} from "palimpsest/evaluation";
import {
  ResultsView,
  revealedResultsSchema,
  type RevealedResults,
} from "./results-view";

type DatasetView = {
  datasetId: string;
  name: string;
  cases: BlindEvaluationCase[];
  annotations: AnnotationEvent[];
};
type ExperimentSummary = {
  experimentId: string;
  success: number;
  planned: number;
  createdAt: string;
};
const roles = [
  "substantive_attribution",
  "background_context",
  "methods_materials",
  "acknowledgment_or_low_information",
  "unclear",
];
const grades = ["irrelevant", "contextual", "direct", "cannot_judge"];

export default function EvaluationWorkspace({
  params,
}: {
  params: Promise<{ datasetId: string }>;
}) {
  const { datasetId } = use(params);
  const [data, setData] = useState<DatasetView | null>(null);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [task, setTask] = useState<BlindEvaluationCase["task"]>("adjudication");
  const [selectedId, setSelectedId] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [role, setRole] = useState("");
  const [passageGrades, setPassageGrades] = useState<Record<string, string>>(
    {},
  );
  const [spans, setSpans] = useState<{ start: number; end: number }[]>([]);
  const [noSpan, setNoSpan] = useState(false);
  const [verdict, setVerdict] = useState("");
  const [packetQuality, setPacketQuality] = useState("valid");
  const [evidenceSufficiency, setEvidenceSufficiency] = useState("sufficient");
  const [notes, setNotes] = useState("");
  const [resolveConflict, setResolveConflict] = useState(false);
  const [revealed, setRevealed] = useState<unknown>(null);
  const [experimentResults, setExperimentResults] =
    useState<RevealedResults | null>(null);
  const [message, setMessage] = useState("");
  const contextRef = useRef<HTMLTextAreaElement>(null);

  async function refresh() {
    const response = await fetch(`/api/evaluations/${datasetId}`);
    if (!response.ok) throw new Error(await response.text());
    setData((await response.json()) as DatasetView);
  }
  useEffect(() => {
    void refresh().catch((error: unknown) => setMessage(String(error)));
    void fetch(`/api/evaluations/${datasetId}/experiments`)
      .then(async (response) =>
        setExperiments((await response.json()) as ExperimentSummary[]),
      )
      .catch((error: unknown) => setMessage(String(error)));
  }, [datasetId]);
  const queue = useMemo(
    () => data?.cases.filter((item) => item.task === task) ?? [],
    [data, task],
  );
  const selected = queue.find((item) => item.caseId === selectedId) ?? queue[0];
  const ownEvents =
    data?.annotations.filter(
      (event) =>
        event.caseId === selected?.caseId && event.reviewer === reviewer,
    ) ?? [];
  const current = ownEvents.at(-1);
  const finalLabels =
    data?.annotations.filter(
      (event) => event.caseId === selected?.caseId && event.status === "final",
    ) ?? [];
  const disagreement =
    new Set(finalLabels.map((event) => JSON.stringify(event.value))).size > 1;

  useEffect(() => {
    const value = current?.value;
    setRole(value?.task === "role" ? value.role : "");
    setPassageGrades(value?.task === "rerank" ? value.grades : {});
    setSpans(value?.task === "span" ? value.spans : []);
    setNoSpan(value?.task === "span" ? value.noValidSpan : false);
    setVerdict(value?.task === "adjudication" ? value.verdict : "");
    setPacketQuality(
      value?.task === "adjudication" ? value.packetQuality : "valid",
    );
    setEvidenceSufficiency(
      value?.task === "adjudication" ? value.evidenceSufficiency : "sufficient",
    );
    setNotes(current?.notes ?? "");
    setResolveConflict(false);
    setRevealed(null);
  }, [selected?.caseId, reviewer, current?.eventId]);

  async function save(status: "draft" | "final") {
    if (!selected || !reviewer.trim()) {
      setMessage("Enter a reviewer name and select a case.");
      return;
    }
    const value =
      selected.task === "role"
        ? { task: "role", role }
        : selected.task === "rerank"
          ? { task: "rerank", grades: passageGrades }
          : selected.task === "span"
            ? { task: "span", spans, noValidSpan: noSpan }
            : {
                task: "adjudication",
                verdict,
                packetQuality,
                evidenceSufficiency,
              };
    const response = await fetch(`/api/evaluations/${datasetId}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        caseId: selected.caseId,
        reviewer,
        status,
        expectedHeadEventId: current?.eventId ?? null,
        ...(current ? { supersedesEventId: current.eventId } : {}),
        notes,
        value,
        ...(resolveConflict ? { resolvesConflict: true } : {}),
      }),
    });
    if (!response.ok) {
      setMessage(((await response.json()) as { error: string }).error);
      return;
    }
    setMessage(
      `${status === "final" ? "Finalized" : "Draft saved"} for ${selected.caseId}`,
    );
    await refresh();
  }
  async function reveal() {
    if (!selected || !reviewer.trim()) {
      setMessage("Enter a reviewer name before revealing.");
      return;
    }
    const response = await fetch(`/api/evaluations/${datasetId}/reveal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caseId: selected.caseId, reviewer }),
    });
    if (!response.ok) {
      setMessage(((await response.json()) as { error: string }).error);
      return;
    }
    setRevealed((await response.json()) as unknown);
  }

  async function inspectResults(experimentId: string) {
    if (!reviewer.trim()) {
      setMessage("Enter a reviewer name before opening experiment results.");
      return;
    }
    const response = await fetch(`/api/evaluations/${datasetId}/results`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ experimentId, reviewer }),
    });
    if (!response.ok) {
      setMessage(((await response.json()) as { error: string }).error);
      return;
    }
    setExperimentResults(revealedResultsSchema.parse(await response.json()));
    await refresh();
  }

  return (
    <div className="space-y-5">
      <header>
        <h2 className="font-[var(--font-instrument)] text-3xl">
          {data?.name ?? "Evaluation workspace"}
        </h2>
        <p className="text-xs text-[var(--text-muted)]">{datasetId}</p>
      </header>
      <section className="flex flex-wrap gap-2">
        {(["role", "rerank", "span", "adjudication"] as const).map((name) => (
          <button
            key={name}
            onClick={() => {
              setTask(name);
              setSelectedId("");
            }}
            className={`rounded-full border px-4 py-2 text-sm ${task === name ? "bg-[var(--text)] text-white" : "bg-white"}`}
          >
            {name} (
            {data?.cases.filter((item) => item.task === name).length ?? 0})
          </button>
        ))}
      </section>
      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <aside className="max-h-[70vh] space-y-1 overflow-auto rounded-xl border bg-white p-3">
          <h3 className="mb-2 font-semibold">Cases</h3>
          {queue.map((item, index) => {
            const count =
              data?.annotations.filter(
                (event) =>
                  event.caseId === item.caseId && event.status === "final",
              ).length ?? 0;
            return (
              <button
                key={item.caseId}
                onClick={() => setSelectedId(item.caseId)}
                className={`w-full rounded-lg p-2 text-left text-xs ${selected?.caseId === item.caseId ? "bg-[var(--panel-muted)] font-semibold" : "hover:bg-[var(--panel-muted)]"}`}
              >
                #{index + 1} · {item.seedDoi} ·{" "}
                {count ? `${count} final` : "unlabeled"}
              </button>
            );
          })}
        </aside>
        <main className="space-y-4 rounded-xl border bg-white p-5">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs text-[var(--text-muted)]">
                    {selected.task} · {selected.caseId}
                  </p>
                  <h3 className="font-semibold">Blind annotation</h3>
                </div>
                <label className="text-sm">
                  Reviewer{" "}
                  <input
                    className="ml-2 rounded border p-2"
                    value={reviewer}
                    onChange={(event) => setReviewer(event.target.value)}
                    placeholder="Your name"
                  />
                </label>
              </div>
              {selected.task === "role" ? (
                <>
                  <p className="whitespace-pre-wrap rounded border p-3 text-sm">
                    {selected.context}
                  </p>
                  <p className="text-sm">
                    <strong>Extracted claims:</strong>{" "}
                    {selected.claims?.join("; ")}
                  </p>
                  <label className="block text-sm">
                    Citation role{" "}
                    <select
                      className="ml-2 rounded border p-2"
                      value={role}
                      onChange={(event) => setRole(event.target.value)}
                    >
                      <option value="">Select role</option>
                      {roles.map((name) => (
                        <option key={name} value={name}>
                          {name.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}
              {selected.task === "rerank" ? (
                <>
                  <p className="rounded border p-3 text-sm">
                    <strong>Query:</strong> {selected.query}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    Grade every passage. Contradictions and qualifying
                    conditions may be directly relevant.
                  </p>
                  <div className="max-h-[55vh] space-y-3 overflow-auto">
                    {selected.candidates?.map((candidate, index) => (
                      <div
                        className="rounded border p-3"
                        key={candidate.chunkId}
                      >
                        <div className="mb-2 flex justify-between gap-3 text-xs">
                          <span>Passage {index + 1}</span>
                          <select
                            className="rounded border p-1"
                            value={passageGrades[candidate.chunkId] ?? ""}
                            onChange={(event) =>
                              setPassageGrades({
                                ...passageGrades,
                                [candidate.chunkId]: event.target.value,
                              })
                            }
                          >
                            <option value="">Choose relevance</option>
                            {grades.map((grade) => (
                              <option key={grade} value={grade}>
                                {grade.replaceAll("_", " ")}
                              </option>
                            ))}
                          </select>
                        </div>
                        <p className="whitespace-pre-wrap text-sm">
                          {candidate.text}
                        </p>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              {selected.task === "span" ? (
                <>
                  <p className="text-sm">
                    <strong>Claim:</strong> {selected.claim}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    Select the exact supporting text below. Add alternative
                    acceptable boundaries if needed.
                  </p>
                  <textarea
                    ref={contextRef}
                    readOnly
                    value={selected.context}
                    className="h-64 w-full rounded border p-3 text-sm"
                    onMouseUp={() => {
                      const field = contextRef.current;
                      if (field && field.selectionEnd > field.selectionStart) {
                        setSpans((old) => [
                          ...old,
                          {
                            start: field.selectionStart,
                            end: field.selectionEnd,
                          },
                        ]);
                        setNoSpan(false);
                      }
                    }}
                  />
                  <div className="space-y-1">
                    {spans.map((span, index) => (
                      <div
                        key={`${span.start}-${span.end}-${index}`}
                        className="flex justify-between rounded border p-2 text-xs"
                      >
                        <span>
                          {span.start}–{span.end}:{" "}
                          {selected.context?.slice(span.start, span.end)}
                        </span>
                        <button
                          onClick={() =>
                            setSpans(
                              spans.filter((_, position) => position !== index),
                            )
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  <label className="text-sm">
                    <input
                      type="checkbox"
                      checked={noSpan}
                      onChange={(event) => {
                        setNoSpan(event.target.checked);
                        if (event.target.checked) setSpans([]);
                      }}
                    />{" "}
                    No valid span
                  </label>
                </>
              ) : null}
              {selected.task === "adjudication" ? (
                <>
                  <p className="text-sm">
                    <strong>Seed finding:</strong>{" "}
                    {selected.packet?.familyTrackedClaim}
                  </p>
                  <p className="whitespace-pre-wrap rounded border p-3 text-sm">
                    {selected.packet?.markedCitingContext}
                  </p>
                  <h4 className="font-semibold">Selected cited evidence</h4>
                  <div className="max-h-64 space-y-2 overflow-auto">
                    {selected.packet?.selectedChunks.map((chunk, index) => (
                      <p
                        className="rounded border p-3 text-sm"
                        key={chunk.chunkId}
                      >
                        <strong>#{index + 1}</strong> {chunk.text}
                      </p>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-3 text-sm">
                    <label>
                      Verdict{" "}
                      <select
                        className="ml-2 rounded border p-2"
                        value={verdict}
                        onChange={(event) => setVerdict(event.target.value)}
                      >
                        <option value="">Choose</option>
                        {["F", "D", "E", "U", "not_adjudicable"].map((name) => (
                          <option key={name}>{name}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Packet quality{" "}
                      <select
                        className="ml-2 rounded border p-2"
                        value={packetQuality}
                        onChange={(event) =>
                          setPacketQuality(event.target.value)
                        }
                      >
                        {["valid", "invalid", "unclear"].map((name) => (
                          <option key={name}>{name}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Evidence{" "}
                      <select
                        className="ml-2 rounded border p-2"
                        value={evidenceSufficiency}
                        onChange={(event) =>
                          setEvidenceSufficiency(event.target.value)
                        }
                      >
                        <option value="sufficient">sufficient</option>
                        <option value="limited">limited</option>
                      </select>
                    </label>
                  </div>
                </>
              ) : null}
              <label className="block text-sm">
                Notes
                <textarea
                  className="mt-1 h-20 w-full rounded border p-2"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </label>
              {disagreement ? (
                <label className="text-sm">
                  <input
                    type="checkbox"
                    checked={resolveConflict}
                    onChange={(event) =>
                      setResolveConflict(event.target.checked)
                    }
                  />{" "}
                  This final annotation resolves the disagreement
                </label>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded border px-4 py-2"
                  onClick={() => void save("draft")}
                >
                  Save draft
                </button>
                <button
                  className="rounded bg-[var(--text)] px-4 py-2 text-white"
                  onClick={() => void save("final")}
                >
                  Finalize / revise
                </button>
                <button
                  className="rounded border px-4 py-2"
                  onClick={() => void reveal()}
                >
                  Reveal machine outputs
                </button>
              </div>
              {revealed ? (
                <pre className="max-h-80 overflow-auto rounded border p-3 text-xs">
                  {JSON.stringify(revealed, null, 2)}
                </pre>
              ) : null}
            </>
          ) : (
            <p>No cases in this task.</p>
          )}
        </main>
      </div>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      <section className="rounded-xl border bg-white p-5">
        <h3 className="font-semibold">Experiments</h3>
        {experiments.length ? (
          experiments.map((experiment) => (
            <div
              className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm"
              key={experiment.experimentId}
            >
              <span>
                {experiment.experimentId} · {experiment.success}/
                {experiment.planned} successful
              </span>
              <button
                className="rounded border px-3 py-1"
                onClick={() => void inspectResults(experiment.experimentId)}
              >
                Inspect results (records reveal)
              </button>
            </div>
          ))
        ) : (
          <p className="text-sm text-[var(--text-muted)]">
            No experiments yet. Launch them from the CLI.
          </p>
        )}
        {experimentResults ? <ResultsView value={experimentResults} /> : null}
      </section>
    </div>
  );
}
