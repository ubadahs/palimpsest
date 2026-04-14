"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  stageDefinitions,
  type RunDetail,
  type StageKey,
} from "palimpsest/ui-contract";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/utils";
import { ModelSelect, ModelWithThinking } from "@/components/model-select";

type DiscoverStrategy = "legacy" | "attribution_first";

// ---------------------------------------------------------------------------
// Form state — grouped by pipeline stage
// ---------------------------------------------------------------------------

type FormState = {
  seedDoi: string;
  trackedClaim: string;
  targetStage: StageKey;

  discover: {
    strategy: DiscoverStrategy;
    model: string;
    thinking: boolean;
    topN: number;
    rank: boolean;
    probeBudget: number;
    shortlistCap: number;
    fromYear: string;
    toYear: string;
  };

  screen: {
    groundingModel: string;
    groundingThinking: boolean;
    filterModel: string;
    filterConcurrency: number;
  };

  evidence: {
    llmRerank: boolean;
    rerankModel: string;
    rerankTopN: number;
  };

  curate: {
    targetSize: number;
  };

  adjudicate: {
    model: string;
    thinking: boolean;
    advisor: boolean;
    firstPassModel: string;
  };

  run: {
    forceRefresh: boolean;
    familyConcurrency: number;
  };
};

const defaultState: FormState = {
  seedDoi: "",
  trackedClaim: "",
  targetStage: "adjudicate",

  discover: {
    strategy: "attribution_first",
    model: "claude-haiku-4-5",
    thinking: false,
    topN: 5,
    rank: true,
    probeBudget: 100,
    shortlistCap: 5,
    fromYear: "",
    toYear: "",
  },

  screen: {
    groundingModel: "claude-sonnet-4-6",
    groundingThinking: true,
    filterModel: "claude-haiku-4-5",
    filterConcurrency: 10,
  },

  evidence: {
    llmRerank: true,
    rerankModel: "claude-haiku-4-5",
    rerankTopN: 5,
  },

  curate: {
    targetSize: 20,
  },

  adjudicate: {
    model: "claude-opus-4-6",
    thinking: true,
    advisor: true,
    firstPassModel: "claude-sonnet-4-6",
  },

  run: {
    forceRefresh: false,
    familyConcurrency: 5,
  },
};

// ---------------------------------------------------------------------------
// Flatten nested state → flat API config
// ---------------------------------------------------------------------------

function flattenConfig(s: FormState) {
  return {
    stopAfterStage: s.targetStage,
    forceRefresh: s.run.forceRefresh,
    // Discovery
    discoverStrategy: s.discover.strategy,
    discoverModel: s.discover.model,
    discoverThinking: s.discover.thinking,
    discoverTopN: s.discover.topN,
    discoverRank: s.discover.rank,
    discoverProbeBudget: s.discover.probeBudget,
    discoverShortlistCap: s.discover.shortlistCap,
    ...(s.discover.fromYear
      ? { discoverFromYear: Number(s.discover.fromYear) }
      : {}),
    ...(s.discover.toYear ? { discoverToYear: Number(s.discover.toYear) } : {}),
    // Screen
    screenGroundingModel: s.screen.groundingModel,
    screenGroundingThinking: s.screen.groundingThinking,
    screenFilterModel: s.screen.filterModel,
    screenFilterConcurrency: s.screen.filterConcurrency,
    // Evidence
    evidenceLlmRerank: s.evidence.llmRerank,
    evidenceRerankModel: s.evidence.rerankModel,
    evidenceRerankTopN: s.evidence.rerankTopN,
    // Curate
    curateTargetSize: s.curate.targetSize,
    // Adjudicate
    adjudicateModel: s.adjudicate.model,
    adjudicateThinking: s.adjudicate.thinking,
    adjudicateAdvisor: s.adjudicate.advisor,
    adjudicateFirstPassModel: s.adjudicate.firstPassModel,
    // Run
    familyConcurrency: s.run.familyConcurrency,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type StageGroup =
  | "discover"
  | "screen"
  | "evidence"
  | "curate"
  | "adjudicate"
  | "run";

export function NewRunForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [launchImmediately, setLaunchImmediately] = useState(true);
  const [showManualClaim, setShowManualClaim] = useState(false);
  const [seedPdfFile, setSeedPdfFile] = useState<File | null>(null);
  const [state, setState] = useState<FormState>(defaultState);

  function update<K extends "seedDoi" | "trackedClaim" | "targetStage">(
    key: K,
    value: FormState[K],
  ): void {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  function updateStage<
    G extends StageGroup,
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

    if (!state.seedDoi.trim()) {
      setError("Seed DOI is required.");
      return;
    }

    const trackedClaim =
      showManualClaim && state.trackedClaim.trim()
        ? state.trackedClaim.trim()
        : undefined;

    startTransition(async () => {
      try {
        let seedPdfBase64: string | undefined;
        if (seedPdfFile) {
          const buf = await seedPdfFile.arrayBuffer();
          seedPdfBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        }
        const run = await fetchJson<RunDetail>("/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            seedDoi: state.seedDoi.trim(),
            ...(trackedClaim ? { trackedClaim } : {}),
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
          Enter a seed DOI. By default, discovery is attribution-first: harvest
          what citing papers attribute to the seed, ground families, and build a
          shortlist. You can switch to legacy seed-side claim extraction in
          advanced settings. Then the run screens families, retrieves
          cited-paper evidence, and adjudicates citation fidelity (per family,
          in parallel when there are several).
        </p>
      </CardHeader>
      <CardContent>
        <form className="space-y-8" onSubmit={onSubmit}>
          <div className="grid gap-6">
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-[var(--text)]">
                Seed DOI
              </span>
              <Input
                autoComplete="off"
                placeholder="10.1101/2024.01.01.123456"
                value={state.seedDoi}
                onChange={(event) => update("seedDoi", event.target.value)}
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-semibold text-[var(--text)]">
                Seed paper PDF
                <span className="ml-2 font-normal text-[var(--text-muted)]">
                  optional
                </span>
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                Upload a PDF if the seed paper is paywalled. Bypasses
                open-access lookup and uses GROBID to parse the local copy.
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

            <div className="rounded-[28px] border border-[var(--border)] bg-white/40">
              <button
                className="flex w-full items-center justify-between px-5 py-4 text-left"
                type="button"
                onClick={() => setShowManualClaim((v) => !v)}
              >
                <span className="text-sm font-semibold text-[var(--text)]">
                  Specify a claim manually
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  {showManualClaim
                    ? "Hide — use auto-discovery"
                    : "Optional — overrides auto-discovery"}
                </span>
              </button>
              {showManualClaim ? (
                <div className="border-t border-[var(--border)] px-5 pb-5 pt-4">
                  <p className="mb-3 text-xs text-[var(--text-muted)]">
                    If provided, the discover stage is skipped and the pipeline
                    starts directly at screen with this claim.
                  </p>
                  <Textarea
                    placeholder="State the empirical claim you want to track. Screen will verify it appears in the seed paper's full text before later stages run."
                    value={state.trackedClaim}
                    onChange={(event) =>
                      update("trackedClaim", event.target.value)
                    }
                  />
                </div>
              ) : null}
            </div>
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
                  how claims or attributions are found
                </span>
              </summary>
              <div className={sectionBodyClass}>
                <label className="grid gap-2 md:col-span-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Strategy
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Legacy extracts claims from the seed paper.
                    Attribution-first harvests what citing papers actually
                    attribute to the seed.
                  </span>
                  <select
                    className="h-11 rounded-2xl border border-[var(--border)] bg-white/70 px-4 text-sm"
                    value={state.discover.strategy}
                    onChange={(event) =>
                      updateStage(
                        "discover",
                        "strategy",
                        event.target.value as DiscoverStrategy,
                      )
                    }
                  >
                    <option value="legacy">
                      Legacy (seed-side extraction)
                    </option>
                    <option value="attribution_first">
                      Attribution-first (citing-side harvesting)
                    </option>
                  </select>
                </label>
                <ModelWithThinking
                  label="Model"
                  description="Claude model used for discovery LLM steps (legacy extraction / ranking or attribution-first extraction and grounding)."
                  model={state.discover.model}
                  onModelChange={(v) => updateStage("discover", "model", v)}
                  thinking={state.discover.thinking}
                  onThinkingChange={(v) =>
                    updateStage("discover", "thinking", v)
                  }
                  thinkingDescription="Enable Anthropic thinking for discovery extraction and grounding calls."
                  modelClassName="md:col-span-2"
                />
                {state.discover.strategy === "legacy" ? (
                  <>
                    <label className="grid gap-2">
                      <span className="text-sm font-semibold text-[var(--text)]">
                        Max claims
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">
                        Upper limit on claims passed from discovery to screen.
                      </span>
                      <Input
                        min={1}
                        type="number"
                        value={state.discover.topN}
                        onChange={(event) =>
                          updateStage(
                            "discover",
                            "topN",
                            Number(event.target.value),
                          )
                        }
                      />
                    </label>
                    <div className="grid gap-1 self-end pb-1">
                      <label className="grid cursor-pointer gap-1">
                        <span className="flex items-center gap-3 text-sm text-[var(--text)]">
                          <input
                            checked={state.discover.rank}
                            className="size-4 accent-[var(--accent)]"
                            type="checkbox"
                            onChange={(event) =>
                              updateStage(
                                "discover",
                                "rank",
                                event.target.checked,
                              )
                            }
                          />
                          Rank claims
                        </span>
                        <span className="pl-7 text-xs text-[var(--text-muted)]">
                          Score claims by citing-paper engagement.
                        </span>
                      </label>
                    </div>
                  </>
                ) : (
                  <>
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
                        Shortlist cap
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">
                        Maximum families passed from discovery to screen.
                      </span>
                      <Input
                        min={1}
                        type="number"
                        value={state.discover.shortlistCap}
                        onChange={(event) =>
                          updateStage(
                            "discover",
                            "shortlistCap",
                            Number(event.target.value),
                          )
                        }
                      />
                    </label>
                  </>
                )}
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

            {/* Screen */}
            <details className={sectionClass}>
              <summary className={summaryClass}>
                <span className="text-sm font-semibold text-[var(--text)]">
                  Screen
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  claim grounding and family filtering
                </span>
              </summary>
              <div className={sectionBodyClass}>
                <ModelWithThinking
                  label="Grounding model"
                  description="Model that verifies each claim against the seed paper's full text."
                  model={state.screen.groundingModel}
                  onModelChange={(v) =>
                    updateStage("screen", "groundingModel", v)
                  }
                  thinking={state.screen.groundingThinking}
                  onThinkingChange={(v) =>
                    updateStage("screen", "groundingThinking", v)
                  }
                  thinkingDescription="Enable Anthropic thinking when grounding tracked claims against the seed paper."
                />
                <ModelSelect
                  label="Filter model"
                  description="Model used for LLM claim-family filtering after BM25 pre-filter."
                  value={state.screen.filterModel}
                  onChange={(v) => updateStage("screen", "filterModel", v)}
                />
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Filter concurrency
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Max concurrent LLM calls during claim-family filtering.
                  </span>
                  <Input
                    min={1}
                    type="number"
                    value={state.screen.filterConcurrency}
                    onChange={(event) =>
                      updateStage(
                        "screen",
                        "filterConcurrency",
                        Number(event.target.value),
                      )
                    }
                  />
                </label>
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
                        checked={state.evidence.llmRerank}
                        className="size-4 accent-[var(--accent)]"
                        type="checkbox"
                        onChange={(event) =>
                          updateStage(
                            "evidence",
                            "llmRerank",
                            event.target.checked,
                          )
                        }
                      />
                      LLM reranking
                    </span>
                    <span className="pl-7 text-xs text-[var(--text-muted)]">
                      After keyword retrieval, a model re-ranks passages by
                      relevance. Better accuracy, higher cost.
                    </span>
                  </label>
                </div>
                {state.evidence.llmRerank ? (
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

            {/* Curate */}
            <details className={sectionClass}>
              <summary className={summaryClass}>
                <span className="text-sm font-semibold text-[var(--text)]">
                  Curate
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  audit sample selection
                </span>
              </summary>
              <div className={sectionBodyClass}>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Sample size
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    How many citation-evidence pairs to curate for adjudication.
                  </span>
                  <Input
                    min={1}
                    type="number"
                    value={state.curate.targetSize}
                    onChange={(event) =>
                      updateStage(
                        "curate",
                        "targetSize",
                        Number(event.target.value),
                      )
                    }
                  />
                </label>
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
                  description={
                    state.adjudicate.advisor
                      ? "Handles escalated records where the advisor is uncertain. Runs with extended thinking when enabled."
                      : "Reads evidence and renders fidelity verdicts for all records."
                  }
                  model={state.adjudicate.model}
                  onModelChange={(v) => updateStage("adjudicate", "model", v)}
                  thinking={state.adjudicate.thinking}
                  onThinkingChange={(v) =>
                    updateStage("adjudicate", "thinking", v)
                  }
                  thinkingLabel="Extended thinking"
                  thinkingDescription="The judge model reasons step-by-step before each verdict."
                />
                <div className="grid gap-1 md:col-span-2">
                  <label className="grid cursor-pointer gap-1">
                    <span className="flex items-center gap-3 text-sm text-[var(--text)]">
                      <input
                        checked={state.adjudicate.advisor}
                        className="size-4 accent-[var(--accent)]"
                        type="checkbox"
                        onChange={(event) =>
                          updateStage(
                            "adjudicate",
                            "advisor",
                            event.target.checked,
                          )
                        }
                      />
                      Advisor mode
                    </span>
                    <span className="pl-7 text-xs text-[var(--text-muted)]">
                      A cheaper model makes a first pass on all records. Only
                      records where the advisor reports low confidence or
                      cannot_determine are escalated to the judge model above.
                      Typically saves 50-70% cost.
                    </span>
                  </label>
                </div>
                {state.adjudicate.advisor ? (
                  <div className="grid gap-4 rounded-2xl border border-[var(--border)] bg-white/30 p-4 md:col-span-2 md:grid-cols-2">
                    {state.adjudicate.thinking ? (
                      <p className="text-xs text-[var(--text-muted)] md:col-span-2">
                        The advisor runs with extended thinking for better
                        judgment quality. Escalated records are judged by the
                        model above, also with thinking.
                      </p>
                    ) : null}
                    <ModelSelect
                      label="Advisor model (first pass)"
                      description="Runs structured adjudication on all records before escalation."
                      value={state.adjudicate.firstPassModel}
                      onChange={(v) =>
                        updateStage("adjudicate", "firstPassModel", v)
                      }
                    />
                  </div>
                ) : null}
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
                    Pipeline halts after this stage. Adjudicate runs the full
                    analysis.
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
                        checked={state.run.forceRefresh}
                        className="size-4 accent-[var(--accent)]"
                        type="checkbox"
                        onChange={(event) =>
                          updateStage(
                            "run",
                            "forceRefresh",
                            event.target.checked,
                          )
                        }
                      />
                      Force-refresh cached data
                    </span>
                    <span className="pl-7 text-xs text-[var(--text-muted)]">
                      Re-fetch papers even if already in the local cache.
                    </span>
                  </label>
                </div>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Family parallelism
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    How many claim families run extract → adjudicate at once
                    after screen.
                  </span>
                  <Input
                    min={1}
                    type="number"
                    value={state.run.familyConcurrency}
                    onChange={(event) =>
                      updateStage(
                        "run",
                        "familyConcurrency",
                        Number(event.target.value),
                      )
                    }
                  />
                </label>
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
