import { afterEach, describe, expect, it, vi } from "vitest";
import { providerConfigSchema } from "../../src/evaluation/config.js";
import { fetchJev } from "../../src/evaluation/jev-transport.js";

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
