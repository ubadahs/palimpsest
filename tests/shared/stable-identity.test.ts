import { describe, expect, it } from "vitest";

import {
  buildStableId,
  canonicalSerialize,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";

describe("stable identity primitives", () => {
  it("canonicalizes nested object keys independently of insertion order", () => {
    const left = {
      beta: [{ zeta: 2, alpha: 1 }],
      alpha: { second: true, first: "value" },
    };
    const right = {
      alpha: { first: "value", second: true },
      beta: [{ alpha: 1, zeta: 2 }],
    };

    expect(canonicalSerialize(left)).toBe(canonicalSerialize(right));
    expect(canonicalSha256(left)).toBe(canonicalSha256(right));
  });

  it("changes hashes and stable IDs when semantic inputs change", () => {
    const first = { record: "citation-1", classification: "background" };
    const second = {
      record: "citation-1",
      classification: "substantive",
    };

    expect(canonicalSha256(first)).not.toBe(canonicalSha256(second));
    expect(buildStableId("record", first)).not.toBe(
      buildStableId("record", second),
    );
  });

  it("preserves array order and omits undefined object fields", () => {
    expect(canonicalSha256({ values: [1, 2] })).not.toBe(
      canonicalSha256({ values: [2, 1] }),
    );
    expect(canonicalSerialize({ kept: true, omitted: undefined })).toBe(
      '{"kept":true}',
    );
  });

  it("rejects values that cannot round-trip as canonical JSON", () => {
    expect(() => canonicalSerialize({ value: Number.NaN })).toThrow(
      /Non-finite/,
    );
    expect(() => canonicalSerialize([undefined])).toThrow(
      /Undefined array entry/,
    );
  });
});
