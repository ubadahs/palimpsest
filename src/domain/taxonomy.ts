import { z } from "zod";

const fidelityVerdictValues = ["F", "D", "E", "U"] as const;

export const fidelityVerdictSchema = z.enum(fidelityVerdictValues);
export type FidelityVerdict = z.infer<typeof fidelityVerdictSchema>;

/**
 * Named dimensions along which a citing restatement can move away from the
 * cited claim. They describe a `D`; they never decide one. Both the adjudicator
 * and the human review form draw from this list, so a reviewer's label is
 * comparable to the model's.
 */
export const mutationKindValues = [
  "scope_broadened",
  "scope_narrowed",
  "population_shifted",
  "certainty_strengthened",
  "certainty_weakened",
  "correlation_to_causation",
  "conditions_dropped",
  "endpoint_substituted",
  "generality_increased",
  "entity_substituted",
] as const;

export const mutationKindSchema = z.enum(mutationKindValues);
export type MutationKind = z.infer<typeof mutationKindSchema>;
