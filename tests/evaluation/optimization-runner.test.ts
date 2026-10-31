import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { experimentConfigSchema } from "../../src/evaluation/config.js";
import {
  optimizationStatus,
  optimizationRequestPlan,
  plannedOptimizationTrials,
  runJevOptimization,
} from "../../src/evaluation/optimization-runner.js";
import {
  atomicJson,
  datasetDir,
  experimentDir,
} from "../../src/evaluation/storage.js";
import type { JevTransport } from "../../src/evaluation/jev-transport.js";
import { jevAttemptSchema } from "../../src/evaluation/optimization-contract.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  delete process.env.PALIMPSEST_ROOT;
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "jev-runner-"));
  dirs.push(root);
  process.env.PALIMPSEST_ROOT = root;
  const datasetId = "dataset_test";
  const experimentId = "experiment_test";
  const caseId = "case_rerank";
  atomicJson(join(datasetDir(datasetId), "dataset.json"), {
    schemaVersion: "evaluation-dataset-v1",
    builderVersion: "evaluation-build-v2",
    datasetId,
    name: "test",
    sources: [
      { runId: "run", reportArtifactId: "report", reportContentHash: "hash" },
    ],
    cases: [
      {
        caseId,
        runId: "run",
        seedDoi: "10.test/seed",
        recordId: "record",
        sourceArtifactHashes: { report: "hash" },
        task: "rerank",
        query: "alpha",
        candidates: [
          {
            chunkId: "a",
            text: "alpha evidence",
            sourceBlockKind: "body_paragraph",
            sectionRole: "results",
            citesOtherWork: false,
          },
          {
            chunkId: "b",
            text: "beta context",
            sourceBlockKind: "body_paragraph",
            sectionRole: "background",
            citesOtherWork: true,
          },
        ],
        pinnedPassages: [],
        bm25Order: ["b", "a"],
        pinnedChunkIds: [],
        selectionLimit: 2,
      },
    ],
  });
  const config = experimentConfigSchema.parse({
    schemaVersion: "evaluation-experiment-config-v1",
    tasks: ["rerank"],
    providers: [
      {
        id: "jev",
        kind: "jev",
        model: "test-model",
        endpoint: "https://example.invalid/systemone",
      },
    ],
    optimization: {
      variants: [
        {
          id: "fixture",
          task: "rerank",
          layout: "passage-per-question",
          phase: "fixture",
        },
        {
          id: "main",
          task: "rerank",
          layout: "passage-per-question",
          batchSize: 1,
          phase: "main",
          caseIds: [caseId],
        },
      ],
      maxAttempts: 20,
      maxActiveSeconds: 60,
      concurrency: 2,
      minimumRequestIntervalMs: 0,
      probeMinimumRequestIntervalMs: 0,
      retryBaseDelayMs: 1,
    },
  });
  mkdirSync(join(experimentDir(experimentId), "trials"), { recursive: true });
  atomicJson(
    join(experimentDir(experimentId), "optimization-plan.json"),
    optimizationRequestPlan(datasetId, config),
  );
  for (const trial of plannedOptimizationTrials(
    experimentId,
    datasetId,
    config,
  ))
    atomicJson(
      join(experimentDir(experimentId), "trials", `${trial.trialId}.json`),
      trial,
    );
  return { datasetId, experimentId, config };
}

function answer(body: unknown) {
  const request = body as {
    state: { markedCitingContext?: string; query?: string };
    questions: Record<string, unknown>;
  };
  if (request.state.markedCitingContext)
    return {
      model: "test-model",
      answers: {
        decision: {
          type: "choice",
          choice: request.state.markedCitingContext.includes("protocol")
            ? "methods_materials"
            : "substantive_attribution",
        },
      },
    };
  return {
    model: "test-model",
    answers: Object.fromEntries(
      Object.keys(request.questions).map((key, index) => [
        key,
        { type: "score", score: index === 0 ? 2 : 0 },
      ]),
    ),
  };
}

describe("Jev optimization execution", () => {
  it("stops sequential corpus dispatch after repeated upstream failures", async () => {
    const { datasetId, experimentId, config } = setup();
    config.optimization!.concurrency = 1;
    config.optimization!.stopAfterConsecutiveServiceFailures = 2;
    atomicJson(
      join(experimentDir(experimentId), "optimization-plan.json"),
      optimizationRequestPlan(datasetId, config),
    );
    const transport = vi.fn<JevTransport>((_provider, body) =>
      Promise.resolve(
        JSON.stringify(body).includes('"query":"alpha"')
          ? { httpStatus: 503 }
          : { httpStatus: 200, body: answer(body) },
      ),
    );
    const result = await runJevOptimization(
      experimentId,
      datasetId,
      config,
      transport,
    );
    expect(result).toMatchObject({
      completed: 6,
      pending: 2,
      attempts: 8,
      accessErrors: ["Stopped after 2 consecutive service failures"],
      peakConcurrency: 1,
    });
    expect(transport).toHaveBeenCalledTimes(8);
  });

  it("saves error diagnostics and stops probe escalation on HTTP 503", async () => {
    const { datasetId, experimentId, config } = setup();
    const main = config.optimization!.variants[1]!;
    main.phase = "probe";
    main.concurrencyCeiling = 1;
    config.optimization!.variants.push({
      ...main,
      id: "probe-two",
      concurrencyCeiling: 2,
    });
    atomicJson(
      join(experimentDir(experimentId), "optimization-plan.json"),
      optimizationRequestPlan(datasetId, config),
    );
    for (const trial of plannedOptimizationTrials(
      experimentId,
      datasetId,
      config,
    ))
      atomicJson(
        join(experimentDir(experimentId), "trials", `${trial.trialId}.json`),
        trial,
      );
    const diagnostics = {
      responseHeaders: { "x-request-id": "upstream-one" },
      errorBody: '{"error":{"code":"provider_unavailable"}}',
      bodyTruncated: false,
    };
    const transport = vi.fn<JevTransport>((_provider, body) =>
      Promise.resolve(
        JSON.stringify(body).includes('"query":"alpha"')
          ? { httpStatus: 503, diagnostics }
          : { httpStatus: 200, body: answer(body) },
      ),
    );
    await runJevOptimization(experimentId, datasetId, config, transport);
    expect(transport).toHaveBeenCalledTimes(7);
    const attempts = readdirSync(
      join(experimentDir(experimentId), "attempts"),
    ).map((name) =>
      jevAttemptSchema.parse(
        JSON.parse(
          readFileSync(
            join(experimentDir(experimentId), "attempts", name),
            "utf8",
          ),
        ),
      ),
    );
    expect(
      attempts.find((attempt) => attempt.httpStatus === 503)?.diagnostics,
    ).toEqual(diagnostics);
    expect(attempts.some((attempt) => attempt.variantId === "probe-two")).toBe(
      false,
    );
  });

  it("gates corpus work on all six fixtures and reuses complete batches on resume", async () => {
    const { datasetId, experimentId, config } = setup();
    const transport = vi.fn<JevTransport>((_provider, body) =>
      Promise.resolve({ httpStatus: 200, body: answer(body) }),
    );
    const first = await runJevOptimization(
      experimentId,
      datasetId,
      config,
      transport,
    );
    expect(first.completed).toBe(8);
    expect(first.pending).toBe(0);
    expect(transport).toHaveBeenCalledTimes(8);
    const second = await runJevOptimization(
      experimentId,
      datasetId,
      config,
      transport,
    );
    expect(second.completed).toBe(8);
    expect(transport).toHaveBeenCalledTimes(8);
    const attempts = readdirSync(join(experimentDir(experimentId), "attempts"));
    expect(attempts).toHaveLength(8);
    expect(optimizationStatus(experimentId)).toMatchObject({
      plannedRequests: 8,
      completedRequests: 8,
      pendingRequests: 0,
      byPhase: {
        fixture: { planned: 6, completed: 6 },
        main: { planned: 2, completed: 2 },
      },
    });
  });

  it("reconstructs a saved successful response if the process ended before writing its result", async () => {
    const { datasetId, experimentId, config } = setup();
    const transport = vi.fn<JevTransport>((_provider, body) =>
      Promise.resolve({ httpStatus: 200, body: answer(body) }),
    );
    await runJevOptimization(experimentId, datasetId, config, transport);
    const trial = plannedOptimizationTrials(
      experimentId,
      datasetId,
      config,
    )[0]!;
    const result = join(
      experimentDir(experimentId),
      "results",
      `${trial.requestIds![0]}.json`,
    );
    unlinkSync(result);
    await runJevOptimization(experimentId, datasetId, config, transport);
    expect(transport).toHaveBeenCalledTimes(8);
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({
      requestId: trial.requestIds![0],
    });
  });

  it("stops before scientific requests when a fixture answer is wrong", async () => {
    const { datasetId, experimentId, config } = setup();
    const transport = vi.fn<JevTransport>((_provider, body) => {
      const response = answer(body);
      const request = body as { state: { markedCitingContext?: string } };
      if (request.state.markedCitingContext?.includes("protocol"))
        response.answers.decision = {
          type: "choice",
          choice: "background_context",
        };
      return Promise.resolve({ httpStatus: 200, body: response });
    });
    const result = await runJevOptimization(
      experimentId,
      datasetId,
      config,
      transport,
    );
    expect(result.completed).toBeLessThan(6);
    expect(result.accessErrors).toContain(
      "Fixture validation failed; corpus dispatch was stopped",
    );
    expect(transport).toHaveBeenCalledTimes(6);
  });

  it("preserves a completed sibling batch after another batch fails", async () => {
    const { datasetId, experimentId, config } = setup();
    const transport = vi.fn<JevTransport>((_provider, body) => {
      const serialized = JSON.stringify(body);
      if (
        serialized.includes('"query":"alpha"') &&
        serialized.includes("beta context")
      )
        return Promise.resolve({ httpStatus: 422 });
      return Promise.resolve({ httpStatus: 200, body: answer(body) });
    });
    const first = await runJevOptimization(
      experimentId,
      datasetId,
      config,
      transport,
    );
    expect(first.completed).toBe(7);
    expect(first.pending).toBe(1);
    await runJevOptimization(experimentId, datasetId, config, transport);
    expect(transport).toHaveBeenCalledTimes(8);
  });

  it("refuses a changed frozen request plan before dispatch", async () => {
    const { datasetId, experimentId, config } = setup();
    atomicJson(join(experimentDir(experimentId), "optimization-plan.json"), {
      requests: [],
    });
    const transport = vi.fn<JevTransport>((_provider, body) =>
      Promise.resolve({ httpStatus: 200, body: answer(body) }),
    );
    await expect(
      runJevOptimization(experimentId, datasetId, config, transport),
    ).rejects.toThrow("request plan changed");
    expect(transport).not.toHaveBeenCalled();
  });

  it("honors Retry-After and persists the two-retry ceiling across resumes", async () => {
    const { datasetId, experimentId, config } = setup();
    const timestamps: number[] = [];
    const transport = vi.fn<JevTransport>((_provider, body) => {
      const serialized = JSON.stringify(body);
      if (
        serialized.includes('"query":"alpha"') &&
        serialized.includes("alpha evidence")
      ) {
        timestamps.push(Date.now());
        return Promise.resolve({ httpStatus: 429, retryAfterMs: 15 });
      }
      return Promise.resolve({ httpStatus: 200, body: answer(body) });
    });
    const first = await runJevOptimization(
      experimentId,
      datasetId,
      config,
      transport,
    );
    expect(first.pending).toBe(1);
    expect(timestamps).toHaveLength(3);
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(14);
    expect(timestamps[2]! - timestamps[1]!).toBeGreaterThanOrEqual(14);
    await runJevOptimization(experimentId, datasetId, config, transport);
    expect(timestamps).toHaveLength(3);
    const attempts = readdirSync(
      join(experimentDir(experimentId), "attempts"),
    ).map(
      (name) =>
        JSON.parse(
          readFileSync(
            join(experimentDir(experimentId), "attempts", name),
            "utf8",
          ),
        ) as { httpStatus?: number },
    );
    expect(
      attempts.filter((attempt) => attempt.httpStatus === 429),
    ).toHaveLength(3);
  });

  it("keeps the global attempt cap after resuming", async () => {
    const { datasetId, experimentId, config } = setup();
    config.optimization!.maxAttempts = 7;
    atomicJson(
      join(experimentDir(experimentId), "optimization-plan.json"),
      optimizationRequestPlan(datasetId, config),
    );
    const transport = vi.fn<JevTransport>((_provider, body) =>
      Promise.resolve({ httpStatus: 200, body: answer(body) }),
    );
    const first = await runJevOptimization(
      experimentId,
      datasetId,
      config,
      transport,
    );
    expect(first.completed).toBe(7);
    expect(transport).toHaveBeenCalledTimes(7);
    await runJevOptimization(experimentId, datasetId, config, transport);
    expect(transport).toHaveBeenCalledTimes(7);
  });

  it("records a timed out request and retries it only twice", async () => {
    const { datasetId, experimentId, config } = setup();
    const transport = vi.fn<JevTransport>((_provider, body) => {
      if (JSON.stringify(body).includes('"query":"alpha"'))
        return Promise.reject(new DOMException("Timed out", "TimeoutError"));
      return Promise.resolve({ httpStatus: 200, body: answer(body) });
    });
    await runJevOptimization(experimentId, datasetId, config, transport);
    const attempts = readdirSync(
      join(experimentDir(experimentId), "attempts"),
    ).map(
      (name) =>
        JSON.parse(
          readFileSync(
            join(experimentDir(experimentId), "attempts", name),
            "utf8",
          ),
        ) as { status: string; error?: string },
    );
    expect(
      attempts.filter((attempt) => attempt.status === "network_error"),
    ).toHaveLength(6);
    expect(
      attempts.filter((attempt) => attempt.error === "Request timeout"),
    ).toHaveLength(6);
  });

  it("runs probe ceilings in order and respects each concurrency limit", async () => {
    const { datasetId, experimentId, config } = setup();
    config.optimization!.variants.push(
      {
        id: "probe-1",
        task: "rerank",
        layout: "passage-per-question",
        batchSize: 1,
        phase: "probe",
        caseIds: ["case_rerank"],
        questionOrder: "stable",
        repetition: 1,
        concurrencyCeiling: 1,
      },
      {
        id: "probe-2",
        task: "rerank",
        layout: "passage-per-question",
        batchSize: 1,
        phase: "probe",
        caseIds: ["case_rerank"],
        questionOrder: "stable",
        repetition: 1,
        concurrencyCeiling: 2,
      },
    );
    atomicJson(
      join(experimentDir(experimentId), "optimization-plan.json"),
      optimizationRequestPlan(datasetId, config),
    );
    for (const trial of plannedOptimizationTrials(
      experimentId,
      datasetId,
      config,
    ))
      atomicJson(
        join(experimentDir(experimentId), "trials", `${trial.trialId}.json`),
        trial,
      );
    let scientificCalls = 0;
    const active = { main: 0, one: 0, two: 0 };
    const peak = { main: 0, one: 0, two: 0 };
    const transport = vi.fn<JevTransport>(async (_provider, body) => {
      if (JSON.stringify(body).includes('"query":"alpha"')) {
        scientificCalls++;
        const group =
          scientificCalls <= 2 ? "main" : scientificCalls <= 4 ? "one" : "two";
        active[group]++;
        peak[group] = Math.max(peak[group], active[group]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active[group]--;
      }
      return { httpStatus: 200, body: answer(body) };
    });
    const result = await runJevOptimization(
      experimentId,
      datasetId,
      config,
      transport,
    );
    expect(result.completed).toBe(12);
    expect(peak.one).toBe(1);
    expect(peak.two).toBe(2);
    const summary = JSON.parse(
      readFileSync(
        join(experimentDir(experimentId), "execution-summary.json"),
        "utf8",
      ),
    ) as { peakConcurrencyByVariant: Record<string, number> };
    expect(summary.peakConcurrencyByVariant["probe-1"]).toBe(1);
    expect(summary.peakConcurrencyByVariant["probe-2"]).toBe(2);
  });

  it("interrupts in-flight requests when the active-time deadline expires", async () => {
    const { datasetId, experimentId, config } = setup();
    config.optimization!.maxActiveSeconds = 1;
    const transport = vi.fn<JevTransport>(
      (_provider, _body, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const result = await runJevOptimization(
      experimentId,
      datasetId,
      config,
      transport,
    );
    expect(result.completed).toBe(0);
    const attempts = readdirSync(
      join(experimentDir(experimentId), "attempts"),
    ).map(
      (name) =>
        JSON.parse(
          readFileSync(
            join(experimentDir(experimentId), "attempts", name),
            "utf8",
          ),
        ) as { status: string; error?: string },
    );
    expect(attempts.length).toBeGreaterThan(0);
    expect(
      attempts.every(
        (attempt) =>
          attempt.status === "interrupted" &&
          attempt.error?.includes("uncertain"),
      ),
    ).toBe(true);
  });
});
