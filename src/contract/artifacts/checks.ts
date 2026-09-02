/**
 * Cross-cutting consistency checks used by the stage payload validators.
 *
 * These are leaf helpers: they know about artifact references and identifier
 * lists, and nothing about any particular stage.
 */
import type { z } from "zod";

import { compareCodeUnits } from "../../shared/order.js";
import { canonicalSerialize } from "../../shared/stable-identity.js";
import type { ArtifactReference } from "../lean-artifact-primitives.js";

export function addIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

export function validateScoreOrdering<T>(
  values: readonly T[],
  getScore: (value: T) => number,
  getTieBreaker: (value: T) => string,
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  for (let index = 1; index < values.length; index++) {
    const previous = values[index - 1]!;
    const current = values[index]!;
    const previousScore = getScore(previous);
    const currentScore = getScore(current);
    if (
      currentScore > previousScore ||
      (currentScore === previousScore &&
        compareCodeUnits(getTieBreaker(previous), getTieBreaker(current)) > 0)
    ) {
      context.addIssue({
        code: "custom",
        path,
        message:
          "Ranking scores must descend with deterministic identifier tie-breaking",
      });
      return;
    }
  }
}

export function addDuplicateIdentifierIssue(
  values: readonly string[],
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  const duplicate = findDuplicate(values);
  if (duplicate) {
    context.addIssue({
      code: "custom",
      path,
      message: `Duplicate stable identifier: ${duplicate}`,
    });
  }
}

export function addSortedUniqueIdentifierIssue(
  values: readonly string[],
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  addDuplicateIdentifierIssue(values, path, context);
  if (!sameIdentifierSequence(values, [...values].sort(compareCodeUnits))) {
    context.addIssue({
      code: "custom",
      path,
      message: "Stable identifier references must be sorted deterministically",
    });
  }
}

export function sameIdentifierSequence(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function hasArtifactReference(
  references: readonly ArtifactReference[],
  expected: ArtifactReference,
): boolean {
  return references.some((reference) =>
    sameArtifactReference(reference, expected),
  );
}

export function sameArtifactReference(
  left: ArtifactReference | undefined,
  right: ArtifactReference,
): boolean {
  return left != null && canonicalSerialize(left) === canonicalSerialize(right);
}

export function sortedUniqueIdentifiers(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

export function findDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

export function normalizeDoi(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/doi\.org\//, "");
}

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
