import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../src/shared/stable-identity.js";
import { preserveReferencedProvenance } from "../../src/pipeline/provenance-store.js";
import { makeStore, removeStores } from "../stages/adapters.fixture.js";

afterEach(removeStores);

describe("provenance store", () => {
  it("preserves nested sources across stores and detects missing or corrupted inputs", () => {
    const source = makeStore();
    const result = makeStore();
    const quote = source.persist({
      role: "source-text",
      body: { text: "An exact source passage." },
    });
    const request = source.persist({ role: "request", body: { input: quote } });
    const unrelated = source.persist({ role: "unrelated", body: 123 });
    expect(() => preserveReferencedProvenance([request], result, [])).toThrow(
      "Missing referenced provenance",
    );
    preserveReferencedProvenance(
      { primary: request, repeated: request },
      result,
      [source],
    );
    expect(result.load(quote)).toEqual(source.load(quote));
    expect(result.load(request)).toEqual(source.load(request));
    expect(existsSync(result.pathFor(unrelated))).toBe(false);
    writeFileSync(
      result.pathFor(quote),
      JSON.stringify({ ...result.load(quote), body: { text: "replaced" } }),
    );
    expect(() =>
      preserveReferencedProvenance(request, result, [source]),
    ).toThrow("does not match");
  });

  it("stores identical bodies under different roles without overwrite", () => {
    const store = makeStore();
    const body = { exact: "normalized boundary body" };
    const request = store.persist({ role: "request-role", body });
    const response = store.persist({ role: "response-role", body });

    expect(request.contentHash).toBe(response.contentHash);
    expect(request.artifactId).not.toBe(response.artifactId);
    expect(store.pathFor(request)).not.toBe(store.pathFor(response));
    expect(store.load(request)).toEqual({
      role: "request-role",
      contentHash: canonicalSha256(body),
      body,
    });
    expect(store.load(response)).toEqual({
      role: "response-role",
      contentHash: canonicalSha256(body),
      body,
    });
    expect(
      JSON.parse(readFileSync(store.pathFor(request), "utf8")),
    ).toMatchObject({ role: "request-role", body });
  });
});
