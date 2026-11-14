import { describe, expect, it } from "vitest";

import { parseArxivId } from "../../src/shared/arxiv.js";

describe("parseArxivId", () => {
  it("reads identifiers from references, URLs, and DOIs without version", () => {
    expect(parseArxivId("arXiv:1801.00001v3")).toBe("1801.00001");
    expect(parseArxivId("https://arxiv.org/pdf/2101.12345")).toBe("2101.12345");
    expect(parseArxivId("http://arxiv.org/abs/2101.12345v1")).toBe(
      "2101.12345",
    );
    expect(parseArxivId("10.48550/arXiv.2101.12345")).toBe("2101.12345");
    expect(parseArxivId("arXiv:astro-ph/9904188")).toBe("astro-ph/9904188");
  });

  it("ignores numbers that are not marked as arXiv", () => {
    expect(parseArxivId("Phys. Rev. D 97, 1801.00001")).toBeUndefined();
    expect(parseArxivId("")).toBeUndefined();
  });
});
