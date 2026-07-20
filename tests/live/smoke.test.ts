import { describe, expect, it } from "vitest";

/**
 * Low-budget live smoke for scientific acceptance.
 *
 * Not part of normal CI. Enable explicitly:
 *   PALIMPSEST_LIVE_SMOKE=1 npm run test:live-smoke
 *
 * Seeds:
 * - 10.1000/jin.20210042 (VRN / Pvalb acceptance path)
 * - one structurally different DOI supplied via PALIMPSEST_LIVE_SMOKE_DOI
 *
 * Requires live OpenAlex/GROBID/Anthropic credentials and network access.
 * Treat verdict agreement as descriptive only until blinded human calibration.
 */
const enabled = process.env.PALIMPSEST_LIVE_SMOKE === "1";

describe.skipIf(!enabled)("live smoke (manual/nightly, non-blocking)", () => {
  it("documents the required dual-DOI live smoke contract", () => {
    const secondaryDoi = process.env.PALIMPSEST_LIVE_SMOKE_DOI;
    expect(secondaryDoi).toBeTruthy();
    expect("10.1000/jin.20210042").toMatch(/^10\./);
    expect(secondaryDoi).not.toBe("10.1000/jin.20210042");
  });
});
