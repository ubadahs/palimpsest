import { describe, expect, it } from "vitest";

import {
  MARKDOWN_EXAMPLES_PER_VERDICT,
  MARKDOWN_RECORD_DETAIL_LIMIT,
  renderCanonicalReportMarkdown,
} from "../../src/reporting/canonical-report-markdown.js";
import { buildLargeReportChain } from "./large-report.fixture.js";

describe("canonical Report Markdown at census scale", () => {
  it("summarizes per family, so its size follows families, not records", async () => {
    const families = 120;
    const { report } = await buildLargeReportChain({
      citingPapers: 1500,
      families,
    });
    const payload = report.payload;
    expect(payload.recordTraces).toHaveLength(3000);
    expect(payload.familyMutations).toHaveLength(families);
    expect(payload.recordTraces.length).toBeGreaterThan(
      MARKDOWN_RECORD_DETAIL_LIMIT,
    );

    const markdown = renderCanonicalReportMarkdown(payload);
    const lines = markdown.split("\n");
    // Per family: a heading, counts, shares, one grounding span, at most
    // MARKDOWN_EXAMPLES_PER_VERDICT examples per verdict (four lines for D
    // and E, two for U and F), a pointer, and a selection-audit row. The
    // rest of the report is a fixed size.
    const perFamily = 10 + MARKDOWN_EXAMPLES_PER_VERDICT * (4 + 4 + 2 + 2);
    expect(lines.length).toBeLessThanOrEqual(families * perFamily + 400);
    // No record is traced one by one, and the JSON is named for the rest.
    expect(markdown).not.toContain("- record=`");
    expect(markdown).toContain("`recordTraces` of the report JSON");
    expect(markdown).toContain(
      "`familyMutations[0].records` of the report JSON",
    );

    // D and E examples come before F within a family.
    const first = markdown.slice(
      markdown.indexOf(`### ${payload.familyMutations[0]!.claim}`),
      markdown.indexOf(`### ${payload.familyMutations[1]!.claim}`),
    );
    const verdicts = [...first.matchAll(/· \*\*([DEFU])\*\*/g)].map(
      (match) => match[1],
    );
    expect(verdicts.slice(0, 2)).toEqual(["D", "D"]);
    expect(verdicts.indexOf("F")).toBeGreaterThan(verdicts.lastIndexOf("E"));
    expect(verdicts.filter((verdict) => verdict === "F")).toHaveLength(
      MARKDOWN_EXAMPLES_PER_VERDICT,
    );
  }, 180_000);
});
