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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/utils";

type DiscoverStrategy = "legacy" | "attribution_first";

type FormState = {
  seedDoi: string;
  trackedClaim: string;
  targetStage: StageKey;
  forceRefresh: boolean;
  discoverStrategy: DiscoverStrategy;
  discoverModel: string;
  discoverTopN: number;
  discoverRank: boolean;
  discoverProbeBudget: number;
  discoverShortlistCap: number;
  screenGroundingModel: string;
  screenFilterModel: string;
  screenFilterConcurrency: number;
  evidenceLlmRerank: boolean;
  evidenceRerankModel: string;
  evidenceRerankTopN: number;
  curateTargetSize: number;
  adjudicateModel: string;
  adjudicateThinking: boolean;
  familyConcurrency: number;
};

export function NewRunForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [launchImmediately, setLaunchImmediately] = useState(true);
  const [showManualClaim, setShowManualClaim] = useState(false);
  const [state, setState] = useState<FormState>({
    seedDoi: "",
    trackedClaim: "",
    targetStage: "adjudicate",
    forceRefresh: false,
    discoverStrategy: "attribution_first",
    discoverModel: "claude-opus-4-6",
    discoverTopN: 5,
    discoverRank: true,
    discoverProbeBudget: 20,
    discoverShortlistCap: 10,
    screenGroundingModel: "claude-opus-4-6",
    screenFilterModel: "claude-haiku-4-5",
    screenFilterConcurrency: 10,
    evidenceLlmRerank: true,
    evidenceRerankModel: "claude-haiku-4-5",
    evidenceRerankTopN: 5,
    curateTargetSize: 40,
    adjudicateModel: "claude-opus-4-6",
    adjudicateThinking: true,
    familyConcurrency: 3,
  });

  function update<K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ): void {
    setState((current) => ({ ...current, [key]: value }));
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
        const run = await fetchJson<RunDetail>("/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            seedDoi: state.seedDoi.trim(),
            ...(trackedClaim ? { trackedClaim } : {}),
            targetStage: state.targetStage,
            config: {
              stopAfterStage: state.targetStage,
              forceRefresh: state.forceRefresh,
              discoverStrategy: state.discoverStrategy,
              discoverModel: state.discoverModel,
              discoverTopN: state.discoverTopN,
              discoverRank: state.discoverRank,
              discoverProbeBudget: state.discoverProbeBudget,
              discoverShortlistCap: state.discoverShortlistCap,
              screenGroundingModel: state.screenGroundingModel,
              screenFilterModel: state.screenFilterModel,
              screenFilterConcurrency: state.screenFilterConcurrency,
              evidenceLlmRerank: state.evidenceLlmRerank,
              evidenceRerankModel: state.evidenceRerankModel,
              evidenceRerankTopN: state.evidenceRerankTopN,
              curateTargetSize: state.curateTargetSize,
              adjudicateModel: state.adjudicateModel,
              adjudicateThinking: state.adjudicateThinking,
              familyConcurrency: state.familyConcurrency,
            },
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
                    value={state.discoverStrategy}
                    onChange={(event) =>
                      update(
                        "discoverStrategy",
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
                <label className="grid gap-2 md:col-span-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Model
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Claude model used for discovery LLM steps (legacy extraction
                    / ranking or attribution-first grounding).
                  </span>
                  <Input
                    autoComplete="off"
                    value={state.discoverModel}
                    onChange={(event) =>
                      update("discoverModel", event.target.value)
                    }
                  />
                </label>
                {state.discoverStrategy === "legacy" ? (
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
                        value={state.discoverTopN}
                        onChange={(event) =>
                          update("discoverTopN", Number(event.target.value))
                        }
                      />
                    </label>
                    <div className="grid gap-1 self-end pb-1">
                      <label className="grid cursor-pointer gap-1">
                        <span className="flex items-center gap-3 text-sm text-[var(--text)]">
                          <input
                            checked={state.discoverRank}
                            className="size-4 accent-[var(--accent)]"
                            type="checkbox"
                            onChange={(event) =>
                              update("discoverRank", event.target.checked)
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
                        value={state.discoverProbeBudget}
                        onChange={(event) =>
                          update(
                            "discoverProbeBudget",
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
                        value={state.discoverShortlistCap}
                        onChange={(event) =>
                          update(
                            "discoverShortlistCap",
                            Number(event.target.value),
                          )
                        }
                      />
                    </label>
                  </>
                )}
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
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Grounding model
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Model that verifies each claim against the seed paper's full
                    text.
                  </span>
                  <Input
                    autoComplete="off"
                    value={state.screenGroundingModel}
                    onChange={(event) =>
                      update("screenGroundingModel", event.target.value)
                    }
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Filter model
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Model used for LLM claim-family filtering after BM25
                    pre-filter.
                  </span>
                  <Input
                    autoComplete="off"
                    value={state.screenFilterModel}
                    onChange={(event) =>
                      update("screenFilterModel", event.target.value)
                    }
                  />
                </label>
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
                    value={state.screenFilterConcurrency}
                    onChange={(event) =>
                      update(
                        "screenFilterConcurrency",
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
                        checked={state.evidenceLlmRerank}
                        className="size-4 accent-[var(--accent)]"
                        type="checkbox"
                        onChange={(event) =>
                          update("evidenceLlmRerank", event.target.checked)
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
                {state.evidenceLlmRerank ? (
                  <>
                    <label className="grid gap-2">
                      <span className="text-sm font-semibold text-[var(--text)]">
                        Rerank model
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">
                        Model used to rerank candidate evidence passages.
                      </span>
                      <Input
                        autoComplete="off"
                        value={state.evidenceRerankModel}
                        onChange={(event) =>
                          update("evidenceRerankModel", event.target.value)
                        }
                      />
                    </label>
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
                        value={state.evidenceRerankTopN}
                        onChange={(event) =>
                          update(
                            "evidenceRerankTopN",
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
                  calibration set sampling
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
                    value={state.curateTargetSize}
                    onChange={(event) =>
                      update("curateTargetSize", Number(event.target.value))
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
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">
                    Model
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    Model that reads evidence and judges citation fidelity.
                  </span>
                  <Input
                    autoComplete="off"
                    value={state.adjudicateModel}
                    onChange={(event) =>
                      update("adjudicateModel", event.target.value)
                    }
                  />
                </label>
                <div className="grid gap-1 self-end pb-1">
                  <label className="grid cursor-pointer gap-1">
                    <span className="flex items-center gap-3 text-sm text-[var(--text)]">
                      <input
                        checked={state.adjudicateThinking}
                        className="size-4 accent-[var(--accent)]"
                        type="checkbox"
                        onChange={(event) =>
                          update("adjudicateThinking", event.target.checked)
                        }
                      />
                      Extended thinking
                    </span>
                    <span className="pl-7 text-xs text-[var(--text-muted)]">
                      The model reasons step-by-step before each verdict.
                    </span>
                  </label>
                </div>
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
                    value={state.familyConcurrency}
                    onChange={(event) =>
                      update("familyConcurrency", Number(event.target.value))
                    }
                  />
                </label>
              </div>
            </details>
          </div>

          {error ? (
            <p className="rounded-2xl border border-[rgba(154,64,54,0.2)] bg-[rgba(154,64,54,0.06)] px-4 py-3 text-sm text-[var(--danger)]">
              {error}
            </p>
          ) : null}

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
