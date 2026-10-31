import { afterEach, describe, expect, it, vi } from "vitest";
import { providerConfigSchema } from "../../src/evaluation/config.js";
import {
  createRequestBudget,
  ProviderRequestError,
} from "../../src/evaluation/providers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EVAL_TEST_KEY;
});

const provider = providerConfigSchema.parse({
  id: "jev",
  kind: "jev",
  model: "test-jev",
  endpoint: "https://example.invalid/systemone",
  apiKeyEnv: "EVAL_TEST_KEY",
  concurrency: 2,
  minimumRequestIntervalMs: 25,
  maxTransientRetries: 1,
});

describe("System One request budget", () => {
  it("spaces requests and records a bounded transient retry", async () => {
    process.env.EVAL_TEST_KEY = "invented-test-key";
    const dispatches: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        dispatches.push(Date.now());
        return Promise.resolve(
          dispatches.length === 1
            ? new Response("busy", {
                status: 503,
                headers: { "retry-after": "0" },
              })
            : Response.json({ model: "test-jev", answers: {} }),
        );
      }),
    );
    let count = 0;
    const budget = createRequestBudget(provider, () => ++count);
    const result = await budget.call({}, new AbortController().signal);
    expect(count).toBe(2);
    expect(dispatches[1]! - dispatches[0]!).toBeGreaterThanOrEqual(20);
    expect(result.call.sequence).toBe(2);
    expect(result.retryCalls).toEqual([
      expect.objectContaining({ sequence: 1, servedModel: "unknown" }),
    ]);
  });

  it("stops immediately on quota errors", async () => {
    process.env.EVAL_TEST_KEY = "invented-test-key";
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response("limited", { status: 429 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    let count = 0;
    const budget = createRequestBudget(provider, () => ++count);
    try {
      await budget.call({}, new AbortController().signal);
      expect.fail("Expected quota error");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      if (!(error instanceof ProviderRequestError)) throw error;
      expect(error.category).toBe("quota");
      expect(error.partialCalls).toHaveLength(1);
      expect(error.partialCalls[0]?.sequence).toBe(1);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(count).toBe(1);
  });
});
