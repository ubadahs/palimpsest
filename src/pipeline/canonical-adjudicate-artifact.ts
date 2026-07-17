import {
  adjudicateArtifactSchema,
  type AdjudicateArtifact,
} from "../contract/lean-artifacts.js";
import { loadJsonArtifact, writeJsonArtifact } from "../shared/artifact-io.js";

const CANONICAL_ADJUDICATE_ARTIFACT_LABEL = "canonical Adjudicate";

export function writeCanonicalAdjudicateArtifact(
  artifactPath: string,
  artifactInput: AdjudicateArtifact,
): void {
  const artifact = adjudicateArtifactSchema.parse(artifactInput);
  writeJsonArtifact(artifactPath, artifact);
}

export function loadCanonicalAdjudicateArtifact(
  artifactPath: string,
): AdjudicateArtifact {
  return loadJsonArtifact(
    artifactPath,
    adjudicateArtifactSchema,
    CANONICAL_ADJUDICATE_ARTIFACT_LABEL,
  );
}
