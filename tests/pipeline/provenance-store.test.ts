import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../src/shared/stable-identity.js";
import { makeStore, removeStores } from "../stages/adapters.fixture.js";

afterEach(removeStores);

describe("provenance store", () => {
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
