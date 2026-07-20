"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  stageDefinitions,
  type RunDetail,
  type StageKey,
} from "palimpsest/contract";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import { fetchJson } from "@/lib/utils";
import { ModelSelect, ModelWithThinking } from "@/components/model-select";

type FormState = {
  /** One DOI per line; order is preserved for canonical Discover. */
  seedDoisText: string;
  targetStage: StageKey;
  discover: {
    probeBudget: number;
    minFamilies: number;
    maxFamilies: number;
    maxPreparedRecords: number;
    fromYear: string;
    toYear: string;
    extractionModel: string;
    extractionThinking: boolean;
  };
  scope: {
    groundingModel: string;
    groundingThinking: boolean;
  };
  evidence: {
    rerankEnabled: boolean;
    rerankModel: string;
    rerankTopN: number;
  };
  adjudicate: {
    model: string;
    thinking: boolean;
  };
  forceRefresh: boolean;
};

function parseSeedDois(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Stack-safe browser base64 encoding for large PDF uploads. */
async function encodeFileAsBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

const defaultState: FormState = {
  seedDoisText: "",
  targetStage: "report",
  discover: {
    probeBudget: 100,
    minFamilies: 15,
    maxFamilies: 25,
    maxPreparedRecords: 100,
    fromYear: "",
    toYear: "",
    extractionModel: "claude-haiku-4-5",
    extractionThinking: false,
  },
  scope: {
    groundingModel: "claude-sonnet-4-6",
    groundingThinking: true,
  },
  evidence: {
    rerankEnabled: false,
    rerankModel: "claude-haiku-4-5",
    rerankTopN: 5,
  },
  adjudicate: {
    model: "claude-opus-4-6",
    thinking: true,
  },
  forceRefresh: false,
};

function flattenConfig(s: FormState) {
  return {
    stopAfterStage: s.targetStage,
    forceRefresh: s.forceRefresh,
    discover: {
      probeBudget: s.discover.probeBudget,
      candidateSelection: {
        mode: "adaptive_portfolio" as const,
        minFamilies: s.discover.minFamilies,
        maxFamilies: s.discover.maxFamilies,
        maxPreparedRecords: s.discover.maxPreparedRecords,
      },
      extractionModel: s.discover.extractionModel,
      extractionThinking: s.discover.extractionThinking,
      ...(s.discover.fromYear ? { fromYear: Number(s.discover.fromYear) } : {}),
      ...(s.discover.toYear ? { toYear: Number(s.discover.toYear) } : {}),
    },
    scope: s.scope,
    prepare: { classifier: "deterministic" as const },
    evidence: s.evidence,
    adjudicate: s.adjudicate,
  };
}

export function NewRunForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [launchImmediately, setLaunchImmediately] = useState(true);
  const [seedPdfFile, setSeedPdfFile] = useState<File | null>(null);
  const [state, setState] = useState<FormState>(defaultState);

  function update<K extends "seedDoisText" | "targetStage" | "forceRefresh">(
    key: K,
    value: FormState[K],
  ): void {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  function updateStage<
    G extends "discover" | "scope" | "evidence" | "adjudicate",
    K extends string & keyof FormState[G],
  >(group: G, key: K, value: FormState[G][K]): void {
    setState((prev) => ({
      ...prev,
      [group]: { ...prev[group], [key]: value },
    }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);

    const seedDois = parseSeedDois(state.seedDoisText);
    if (seedDois.length === 0) {
      setError("Enter at least one seed DOI (one per line).");
      return;
    }
    if (seedPdfFile && seedDois.length > 1) {
      setError("Seed PDF upload is only valid for a single-DOI run.");
      return;
    }

    startTransition(async () => {
      try {
        let seedPdfBase64: string | undefined;
        if (seedPdfFile) {
          seedPdfBase64 = await encodeFileAsBase64(seedPdfFile);
        }
        const run = await fetchJson<RunDetail>("/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            seedDois,
            targetStage: state.targetStage,
            config: flattenConfig(state),
            ...(seedPdfBase64 ? { seedPdfBase64 } : {}),
          }),
        });

        if (launchImmediately) {
          await fetchJson<{ ok: true }>(`/api/runs/${run.id}/start`, {
            method: "POST",
          });
        }

        router.push(`/runs/${run.id}`);
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      }
    });
  }

  const sectionClass =
    "rounded-[28px] border border-[var(--border)] bg-white/40 overflow-hidden";
  const summaryClass =
    "cursor-pointer list-none px-6 py-4 flex items-center justify-between [&::-webkit-details-marker]:hidden";
  const sectionBodyClass =
    "grid gap-4 border-t border-[var(--border)] p-6 md:grid-cols-2";

  return (
    <Card className="mx-auto max-w-4xl overflow-hidden">
      <CardHeader>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
          New Analysis
        </p>
        <h2 className="mt-2 font-[var(--font-instrument)] text-4xl tracking-[-0.03em]">
          Start an analysis
        </h2>
        <p className="mt-3 max-w-2xl text-sm text-[var(--text-muted)]">
          Enter one or more seed DOIs (one per line) to run the canonical
          pipeline: discover, scope, prepare, evidence, adjudicate, and report.
        </p>
      </CardHeader>
      <CardContent>
        <form className="space-y-8" onSubmit={onSubmit}>
          <div className="grid gap-6">
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-[var(--text)]">
                Seed DOIs
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                One DOI per line. Order is preserved. Duplicates are rejected.
              </span>
              <textarea
                autoComplete="off"
                className="min-h-28 rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-3 text-sm text-[var(--text)] outline-none focus:border-[var(--border-strong)]"
                placeholder={"10.1101/2024.01.01.123456\n10.1234/another.seed"}
                value={state.seedDoisText}
                onChange={(event) => update("seedDoisText", event.target.value)}
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-semibold text-[var(--text)]">
                Seed paper PDF
                <span className="ml-2 font-normal text-[var(--text-muted)]">
                  optional · single-DOI only
                </span>
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                Upload a PDF if the seed paper is paywalled. Valid only when
                exactly one DOI is provided. Bypasses open-access lookup and
                uses GROBID to parse the local copy.
              </span>
              <input
                accept=".pdf,application/pdf"
                className="h-11 rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-2 text-sm file:mr-3 file:rounded-full file:border-0 file:bg-[var(--accent)]/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-[var(--accent)]"
                type="file"
                onChange={(event) => {
                  setSeedPdfFile(event.target.files?.[0] ?? null);
                }}
              />
              {seedPdfFile ? (
                <span className="text-xs text-[var(--text-muted)]">
                  {seedPdfFile.name} ({(seedPdfFile.size / 1024).toFixed(0)} KB)
                </span>
              ) : null}
            </label>
          </div>

          <label className="flex cursor-pointer items-center gap-3 text-sm text-[var(--text)]">
            <input
              checked={launchImmediately}
              className="size-4 accent-[var(--accent)]"
              type="checkbox"
              onChange={(event) => setLaunchImmediately(event.target.checked)}
            />
            Launch immediately after creation
          </label>

          <div className="space-y-3">
            {/* Discovery */}
            <details className={sectionClass}>
              <summary className={summaryClass}>
                <span className="text-sm font-semibold text-[var(--text)]">
                  Discovery
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  citing-side attribution discovery
                </span>
              </summary>
              <div className={sectionBodyClass}>
                <ModelWithThinking
                  label="Extraction model"
                  description="Model used to extract citing-paper claims attributed to the seed."
                  model={state.discover.extractionModel}
                  onModelChange={(v) =>
                    updateStage("discover", "extractionModel", v)
                  }
                  thinking={state.discover.extractionThinking}
                  onThinkingChange={(v) =>
                    updateStage("discover", "extractionThinking", v)
                  }
                  thinkingDescription="Enable thinking for claim extraction."
                  modelClassName="md:col-span-2"
                />
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Probe budget
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Maximum citing papers to inspect for in-text mentions.
                  </span>
                  <Input
                    min={1}
                    type="number"
                    value={state.discover.probeBudget}
                    onChange={(event) =>
                      updateStage(
                        "discover",
                        "probeBudget",
                        Number(event.target.value),
                      )
                    }
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Min families
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Adaptive portfolio keeps selecting until at least this many
                    claim families are chosen.
                  </span>
                  <Input
                    min={1}
                    type="number"
                    value={state.discover.minFamilies}
                    onChange={(event) =>
                      updateStage(
                        "discover",
                        "minFamilies",
                        Number(event.target.value),
                      )
                    }
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Max families
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Upper bound on claim families selected for Scope.
                  </span>
                  <Input
                    min={1}
                    type="number"
                    value={state.discover.maxFamilies}
                    onChange={(event) =>
                      updateStage(
                        "discover",
                        "maxFamilies",
                        Number(event.target.value),
                      )
                    }
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Max prepared records
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Budget on family × occurrence prepare records downstream.
                  </span>
                  <Input
                    min={1}
                    type="number"
                    value={state.discover.maxPreparedRecords}
                    onChange={(event) =>
                      updateStage(
                        "discover",
                        "maxPreparedRecords",
                        Number(event.target.value),
                      )
                    }
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    From year
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Only include citing papers published in or after this year.
                  </span>
                  <Input
                    type="number"
                    placeholder="e.g. 2023"
                    value={state.discover.fromYear}
                    onChange={(event) =>
                      updateStage("discover", "fromYear", event.target.value)
                    }
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    To year
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Only include citing papers published in or before this year.
                  </span>
                  <Input
                    type="number"
                    placeholder="e.g. 2026"
                    value={state.discover.toYear}
                    onChange={(event) =>
                      updateStage("discover", "toYear", event.target.value)
                    }
                  />
                </label>
              </div>
            </details>

            {/* Scope */}
            <details className={sectionClass}>
              <summary className={summaryClass}>
                <span className="text-sm font-semibold text-[var(--text)]">
                  Scope
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  materialize seed text and ground scoped families
                </span>
              </summary>
              <div className={sectionBodyClass}>
                <ModelWithThinking
                  label="Grounding model"
                  description="Model that verifies each claim against the seed paper's full text."
                  model={state.scope.groundingModel}
                  onModelChange={(v) =>
                    updateStage("scope", "groundingModel", v)
                  }
                  thinking={state.scope.groundingThinking}
                  onThinkingChange={(v) =>
                    updateStage("scope", "groundingThinking", v)
                  }
                  thinkingDescription="Enable Anthropic thinking when grounding tracked claims against the seed paper."
                />
              </div>
            </details>

            {/* Evidence */}
            <details className={sectionClass}>
              <summary className={summaryClass}>
                <span className="text-sm font-semibold text-[var(--text)]">
                  Evidence
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  cited-paper retrieval and reranking
                </span>
              </summary>
              <div className={sectionBodyClass}>
                <div className="grid gap-1 md:col-span-2">
                  <label className="grid cursor-pointer gap-1">
                    <span className="flex items-center gap-3 text-sm text-[var(--text)]">
                      <input
                        checked={state.evidence.rerankEnabled}
                        className="size-4 accent-[var(--accent)]"
                        type="checkbox"
                        onChange={(event) =>
                          updateStage(
                            "evidence",
                            "rerankEnabled",
                            event.target.checked,
                          )
                        }
                      />
                      LLM reranking
                    </span>
                    <span className="pl-7 text-xs text-[var(--text-muted)]">
                      After keyword retrieval, a model re-ranks passages by
                      relevance. It may improve ranking, costs more, and remains
                      separately auditable and uncalibrated.
                    </span>
                  </label>
                </div>
                {state.evidence.rerankEnabled ? (
                  <>
                    <ModelSelect
                      label="Rerank model"
                      description="Model used to rerank candidate evidence passages."
                      value={state.evidence.rerankModel}
                      onChange={(v) =>
                        updateStage("evidence", "rerankModel", v)
                      }
                    />
                    <label className="grid gap-2">
                      <span className="text-sm font-semibold text-[var(--text)]">
                        Rerank top N
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">
                        How many top passages to return per evaluation task.
                      </span>
                      <Input
                        min={1}
                        type="number"
                        value={state.evidence.rerankTopN}
                        onChange={(event) =>
                          updateStage(
                            "evidence",
                            "rerankTopN",
                            Number(event.target.value),
                          )
                        }
                      />
                    </label>
                  </>
                ) : null}
              </div>
            </details>

            {/* Adjudicate */}
            <details className={sectionClass}>
              <summary className={summaryClass}>
                <span className="text-sm font-semibold text-[var(--text)]">
                  Adjudicate
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  LLM fidelity judgement
                </span>
              </summary>
              <div className={sectionBodyClass}>
                <ModelWithThinking
                  label="Judge model"
                  description="Reads selected evidence and renders one categorical F/D/E/U verdict per eligible record."
                  model={state.adjudicate.model}
                  onModelChange={(v) => updateStage("adjudicate", "model", v)}
                  thinking={state.adjudicate.thinking}
                  onThinkingChange={(v) =>
                    updateStage("adjudicate", "thinking", v)
                  }
                  thinkingLabel="Extended thinking"
                  thinkingDescription="The judge model reasons step-by-step before each verdict."
                />
              </div>
            </details>

            {/* Run Settings */}
            <details className={sectionClass}>
              <summary className={summaryClass}>
                <span className="text-sm font-semibold text-[var(--text)]">
                  Run settings
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  pipeline control
                </span>
              </summary>
              <div className={sectionBodyClass}>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Stop after stage
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Pipeline halts after this canonical stage.
                  </span>
                  <select
                    className="h-11 rounded-2xl border border-[var(--border)] bg-white/70 px-4 text-sm"
                    value={state.targetStage}
                    onChange={(event) =>
                      update("targetStage", event.target.value as StageKey)
                    }
                  >
                    {stageDefinitions.map((stage) => (
                      <option key={stage.key} value={stage.key}>
                        {stage.title}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-1 self-end pb-1">
                  <label className="grid cursor-pointer gap-1">
                    <span className="flex items-center gap-3 text-sm text-[var(--text)]">
                      <input
                        checked={state.forceRefresh}
                        className="size-4 accent-[var(--accent)]"
                        type="checkbox"
                        onChange={(event) =>
                          update("forceRefresh", event.target.checked)
                        }
                      />
                      Force-refresh cached data
                    </span>
                    <span className="pl-7 text-xs text-[var(--text-muted)]">
                      Re-fetch papers even if already in the local cache.
                    </span>
                  </label>
                </div>
              </div>
            </details>
          </div>

          {error ? <ErrorBanner>{error}</ErrorBanner> : null}

          <div className="flex justify-end">
            <Button disabled={isPending} size="lg" type="submit">
              {isPending ? "Preparing run…" : "Create run"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
