"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  stageDefinitions,
  type RunDetail,
  type StageKey,
} from "citation-fidelity/ui-contract";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/utils";

type FormState = {
  seedDoi: string;
  trackedClaim: string;
  targetStage: StageKey;
  forceRefresh: boolean;
  m5TargetSize: number;
  m6Model: string;
  m6Thinking: boolean;
};

export function NewRunForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [launchImmediately, setLaunchImmediately] = useState(true);
  const [state, setState] = useState<FormState>({
    seedDoi: "",
    trackedClaim: "",
    targetStage: "m6-llm-judge",
    forceRefresh: false,
    m5TargetSize: 40,
    m6Model: "claude-opus-4-6",
    m6Thinking: false,
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

    if (!state.seedDoi.trim() || !state.trackedClaim.trim()) {
      setError("Seed DOI and tracked claim are required.");
      return;
    }

    startTransition(async () => {
      try {
        const run = await fetchJson<RunDetail>("/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            seedDoi: state.seedDoi.trim(),
            trackedClaim: state.trackedClaim.trim(),
            targetStage: state.targetStage,
            config: {
              stopAfterStage: state.targetStage,
              forceRefresh: state.forceRefresh,
              m5TargetSize: state.m5TargetSize,
              m6Model: state.m6Model,
              m6Thinking: state.m6Thinking,
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

  return (
    <Card className="mx-auto max-w-4xl overflow-hidden">
      <CardHeader>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
          Run Creation
        </p>
        <h2 className="mt-2 font-[var(--font-instrument)] text-4xl tracking-[-0.03em]">
          One seed DOI, one tracked claim
        </h2>
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
                Tracked claim
              </span>
              <Textarea
                placeholder="State the exact claim family you want the run to track."
                value={state.trackedClaim}
                onChange={(event) => update("trackedClaim", event.target.value)}
              />
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

          <details className="rounded-[28px] border border-[var(--border)] bg-white/55">
            <summary className="cursor-pointer list-none px-6 py-4 text-sm font-semibold text-[var(--text)] [&::-webkit-details-marker]:hidden">
              Advanced pipeline options
              <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                optional
              </span>
            </summary>
            <div className="grid gap-6 border-t border-[var(--border)] p-6 md:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-[var(--text)]">
                  Stop after stage
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  Last pipeline stage this run will execute (M6 is full run).
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
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-[var(--text)]">
                  Calibration sample size (M5)
                </span>
                <Input
                  min={1}
                  type="number"
                  value={state.m5TargetSize}
                  onChange={(event) =>
                    update("m5TargetSize", Number(event.target.value))
                  }
                />
              </label>
              <label className="grid gap-2 md:col-span-2">
                <span className="text-sm font-semibold text-[var(--text)]">
                  LLM adjudication model (M6)
                </span>
                <Input
                  autoComplete="off"
                  value={state.m6Model}
                  onChange={(event) => update("m6Model", event.target.value)}
                />
              </label>
              <div className="grid gap-3 md:col-span-2">
                <label className="flex cursor-pointer items-center gap-3 text-sm text-[var(--text)]">
                  <input
                    checked={state.forceRefresh}
                    className="size-4 accent-[var(--accent)]"
                    type="checkbox"
                    onChange={(event) =>
                      update("forceRefresh", event.target.checked)
                    }
                  />
                  Force-refresh cache-aware stages
                </label>
                <label className="flex cursor-pointer items-center gap-3 text-sm text-[var(--text)]">
                  <input
                    checked={state.m6Thinking}
                    className="size-4 accent-[var(--accent)]"
                    type="checkbox"
                    onChange={(event) =>
                      update("m6Thinking", event.target.checked)
                    }
                  />
                  Enable extended thinking for M6 adjudication
                </label>
              </div>
            </div>
          </details>

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
