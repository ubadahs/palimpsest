import { describe, expect, it } from "vitest";

import { mapFullTextAcquisitionFailure } from "../../src/stages/production.js";
import {} from "./adapters.fixture.js";

describe("production adapter support", () => {
  it("maps publisher paywalls to per-paper unavailable, not provider auth", () => {
    expect(
      mapFullTextAcquisitionFailure({
        failureCode: "paywall",
        error: "HTTP 403 from publisher PDF",
      }),
    ).toEqual({
      reasonCode: "unavailable",
      reason: "HTTP 403 from publisher PDF",
    });
    expect(
      mapFullTextAcquisitionFailure({
        failureCode: "authentication",
        error: "proxy login required",
      }).reasonCode,
    ).toBe("unavailable");
    expect(
      mapFullTextAcquisitionFailure({
        failureCode: "authorization",
        error: "publisher forbidden",
      }).reasonCode,
    ).toBe("unavailable");
    expect(
      mapFullTextAcquisitionFailure({
        failureCode: "not_found",
        error: "no pdf candidate",
      }).reasonCode,
    ).toBe("not_found");
  });
});
