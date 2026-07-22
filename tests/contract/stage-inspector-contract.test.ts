import { describe, expectTypeOf, it } from "vitest";

import type {
  ReportInspectorRecordRow,
  ReportInspectorSummary,
  RunStageDetail,
  StageInspectorPayload,
} from "../../src/contract/index.js";

describe("stage inspector contracts", () => {
  it("ties stage keys to stage-specific inspector payloads", () => {
    type DiscoverDetail = Extract<RunStageDetail, { stageKey: "discover" }>;
    type ScopeDetail = Extract<RunStageDetail, { stageKey: "scope" }>;
    type PrepareDetail = Extract<RunStageDetail, { stageKey: "prepare" }>;
    type EvidenceDetail = Extract<RunStageDetail, { stageKey: "evidence" }>;
    type AdjudicateDetail = Extract<RunStageDetail, { stageKey: "adjudicate" }>;
    type ReportDetail = Extract<RunStageDetail, { stageKey: "report" }>;

    expectTypeOf<DiscoverDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"discover"> | undefined
    >();
    expectTypeOf<ScopeDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"scope"> | undefined
    >();
    expectTypeOf<PrepareDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"prepare"> | undefined
    >();
    expectTypeOf<EvidenceDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"evidence"> | undefined
    >();
    expectTypeOf<AdjudicateDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"adjudicate"> | undefined
    >();
    expectTypeOf<ReportDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"report"> | undefined
    >();
  });

  it("exposes the enriched report inspector summary for browsing", () => {
    type ReportSummary = NonNullable<
      StageInspectorPayload<"report">
    >["summary"];
    expectTypeOf<ReportSummary>().toEqualTypeOf<ReportInspectorSummary>();
    expectTypeOf<ReportSummary["records"]>().toEqualTypeOf<
      ReportInspectorRecordRow[]
    >();
    expectTypeOf<ReportSummary["interpretationWarning"]>().toEqualTypeOf<
      ReportInspectorSummary["interpretationWarning"]
    >();
  });
});
