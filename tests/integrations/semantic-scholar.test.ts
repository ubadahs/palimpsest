import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { resolvePaperByDoi } from "../../src/integrations/semantic-scholar.js";

const fixturesPath = fileURLToPath(
  new URL("../../fixtures/semantic-scholar", import.meta.url),
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixturesPath}/${name}`, "utf8")) as unknown;
}

describe("resolvePaperByDoi", () => {
  it("transforms an S2 paper response into a ResolvedPaper", async () => {
    const fixture = loadFixture("paper-response.json");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(fixture),
      }),
    );

    const result = await resolvePaperByDoi(
      "10.1101/2024.01.15.575745",
      "https://api.semanticscholar.org/graph/v1",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.doi).toBe("10.1101/2024.01.15.575745");
    expect(result.data.title).toBe(
      "A Hedged Finding About Gene X in Mouse Liver",
    );
    expect(result.data.authors).toEqual(["Alice Smith", "Bob Jones"]);
    expect(result.data.source).toBe("semantic_scholar");
    expect(result.data.fullTextStatus.status).toBe("available");
    expect(result.data.openAccessUrl).toContain("biorxiv.org");

    vi.restoreAllMocks();
  });

  it("returns unavailable for closed-access papers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            paperId: "closed123",
            title: "Paywalled Paper",
            authors: [],
            abstract: null,
            isOpenAccess: false,
            openAccessPdf: null,
            externalIds: { DOI: "10.9999/closed" },
          }),
      }),
    );

    const result = await resolvePaperByDoi(
      "10.9999/closed",
      "https://api.semanticscholar.org/graph/v1",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.fullTextStatus.status).toBe("unavailable");

    vi.restoreAllMocks();
  });

  it("returns an error for HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    const result = await resolvePaperByDoi(
      "10.1234/nope",
      "https://api.semanticscholar.org/graph/v1",
    );

    expect(result.ok).toBe(false);

    vi.restoreAllMocks();
  });
});
