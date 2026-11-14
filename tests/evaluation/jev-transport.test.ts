import { afterEach, describe, expect, it, vi } from "vitest";
import { providerConfigSchema } from "../../src/evaluation/config.js";
import {
  fetchJev,
  jevAccessError,
  jevEndpoint,
} from "../../src/evaluation/jev-transport.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Jev failure diagnostics", () => {
  it("retains bounded error text and useful headers without reflected secrets", async () => {
    vi.stubEnv("JEV_TEST_KEY", "test-secret-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          "upstream unavailable Bearer test-secret-key token=another-secret " +
            "x".repeat(5000),
          {
            status: 503,
            headers: {
              "content-type": "text/plain",
              "retry-after": "12",
              "x-vercel-id": "request-one",
              "set-cookie": "private-cookie",
            },
          },
        ),
      ),
    );
    const result = await fetchJev(
      providerConfigSchema.parse({
        id: "test",
        kind: "jev",
        model: "test",
        apiKeyEnv: "JEV_TEST_KEY",
      }),
      {},
      new AbortController().signal,
      1000,
    );
    expect(result.retryAfterMs).toBe(12000);
    expect(result.diagnostics?.errorBody).toContain("upstream unavailable");
    expect(result.diagnostics?.errorBody).toHaveLength(4096);
    expect(result.diagnostics?.bodyTruncated).toBe(true);
    expect(result.diagnostics?.responseHeaders).toEqual({
      "content-type": "text/plain",
      "retry-after": "12",
      "x-vercel-id": "request-one",
    });
    expect(JSON.stringify(result.diagnostics)).not.toMatch(
      /test-secret-key|another-secret|private-cookie/,
    );
  });
});

describe("Jev access", () => {
  const provider = (settings: Record<string, unknown>) =>
    providerConfigSchema.parse({
      id: "dgemma",
      kind: "jev",
      model: "dgemma",
      ...settings,
    });

  it("goes to Typesafe's hosted Jev with its key when a provider names neither", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(jevEndpoint(provider({}))).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
    expect(jevAccessError(provider({}))).toBe(
      "dgemma: missing TYPESAFE_API_KEY",
    );
  });

  it("needs a named endpoint variable and a named key to be set", () => {
    const named = provider({
      endpointEnv: "JEV_TEST_ENDPOINT",
      apiKeyEnv: "JEV_TEST_KEY",
    });
    vi.stubEnv("JEV_TEST_ENDPOINT", "");
    expect(jevAccessError(named)).toBe("dgemma: missing JEV_TEST_ENDPOINT");
    vi.stubEnv("JEV_TEST_ENDPOINT", "https://example.invalid/systemone");
    vi.stubEnv("JEV_TEST_KEY", "");
    expect(jevAccessError(named)).toBe("dgemma: missing JEV_TEST_KEY");
    vi.stubEnv("JEV_TEST_KEY", "invented-test-key");
    expect(jevAccessError(named)).toBeUndefined();
    expect(jevEndpoint(named)).toBe("https://example.invalid/systemone");
  });
});
