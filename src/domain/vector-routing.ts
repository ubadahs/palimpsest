import { z } from "zod";

import { undefinedable } from "./common.js";
import type { AdjudicationVerdict } from "./adjudication.js";

const routingAdjudicationVerdictSchema: z.ZodType<AdjudicationVerdict> = z.enum(
  [
    "supported",
    "partially_supported",
    "overstated_or_generalized",
    "not_supported",
    "cannot_determine",
  ],
);

export const vectorRoutingAdaptiveReasonValues = [
  "axis_verdict_cannot_determine",
  "uncertainty_borderline",
  "core_axis_borderline",
  "sampled_verdict_disagrees_with_axis",
  "bundled_citation_scope_ambiguous",
] as const;
export const vectorRoutingAdaptiveReasonSchema = z.enum(
  vectorRoutingAdaptiveReasonValues,
);
export type VectorRoutingAdaptiveReason = z.infer<
  typeof vectorRoutingAdaptiveReasonSchema
>;

export const vectorRoutingCategoricalEscalationReasonValues = [
  "axis_verdict_cannot_determine",
  "aggregate_uncertainty_high",
  "sample_disagreement_high",
  "axis_variance_high",
  "evidence_grounding_low",
  "claim_identity_low",
  "modal_sampled_verdict_disagrees_with_axis",
  "bundled_citation_scope_ambiguous",
  "vector_trace_failed",
] as const;
export const vectorRoutingCategoricalEscalationReasonSchema = z.enum(
  vectorRoutingCategoricalEscalationReasonValues,
);
export type VectorRoutingCategoricalEscalationReason = z.infer<
  typeof vectorRoutingCategoricalEscalationReasonSchema
>;

export const vectorRoutingFinalVerdictSourceValues = [
  "axis_derived",
  "categorical_escalation",
] as const;
export const vectorRoutingFinalVerdictSourceSchema = z.enum(
  vectorRoutingFinalVerdictSourceValues,
);
export type VectorRoutingFinalVerdictSource = z.infer<
  typeof vectorRoutingFinalVerdictSourceSchema
>;

export const vectorRoutingDecisionSchema = z
  .object({
    version: z.literal("vector-routing-v1"),
    adjudicationMode: z.literal("vector_first"),
    finalVerdictSource: vectorRoutingFinalVerdictSourceSchema,
    triggeredAdaptiveSampling: z.boolean(),
    triggeredCategoricalAdjudicator: z.boolean(),
    initialSampleCount: z.number().int().positive(),
    finalSampleCount: z.number().int().nonnegative(),
    adaptiveSamplingReasons: z.array(vectorRoutingAdaptiveReasonSchema),
    categoricalEscalationReasons: z.array(
      vectorRoutingCategoricalEscalationReasonSchema,
    ),
    acceptedAxisDerivedVerdict: undefinedable(routingAdjudicationVerdictSchema),
    categoricalVerdict: undefinedable(routingAdjudicationVerdictSchema),
  })
  .strict();
export type VectorRoutingDecision = z.infer<typeof vectorRoutingDecisionSchema>;
