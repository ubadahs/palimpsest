import { describe, expectTypeOf, it } from "vitest";

import type {
  RunStageDetail,
  StageInspectorPayload,
} from "../../src/ui-contract/index.js";

describe("stage inspector contracts", () => {
  it("ties stage keys to stage-specific inspector payloads", () => {
    type DiscoverDetail = Extract<RunStageDetail, { stageKey: "discover" }>;
    type ScreenDetail = Extract<RunStageDetail, { stageKey: "screen" }>;
    type ExtractDetail = Extract<RunStageDetail, { stageKey: "extract" }>;
    type ClassifyDetail = Extract<RunStageDetail, { stageKey: "classify" }>;
    type EvidenceDetail = Extract<RunStageDetail, { stageKey: "evidence" }>;
    type CurateDetail = Extract<RunStageDetail, { stageKey: "curate" }>;
    type AdjudicateDetail = Extract<RunStageDetail, { stageKey: "adjudicate" }>;

    expectTypeOf<DiscoverDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"discover"> | undefined
    >();
    expectTypeOf<ScreenDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"screen"> | undefined
    >();
    expectTypeOf<ExtractDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"extract"> | undefined
    >();
    expectTypeOf<ClassifyDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"classify"> | undefined
    >();
    expectTypeOf<EvidenceDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"evidence"> | undefined
    >();
    expectTypeOf<CurateDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"curate"> | undefined
    >();
    expectTypeOf<AdjudicateDetail["inspectorPayload"]>().toEqualTypeOf<
      StageInspectorPayload<"adjudicate"> | undefined
    >();
  });
});
