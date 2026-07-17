import {
  prepareArtifactSchema,
  type PrepareArtifact,
} from "../contract/lean-artifacts.js";
import { loadJsonArtifact, writeJsonArtifact } from "../shared/artifact-io.js";

const CANONICAL_PREPARE_ARTIFACT_LABEL = "canonical Prepare";

export function writeCanonicalPrepareArtifact(
  artifactPath: string,
  artifactInput: PrepareArtifact,
): void {
  const artifact = prepareArtifactSchema.parse(artifactInput);
  writeJsonArtifact(artifactPath, artifact);
}

export function loadCanonicalPrepareArtifact(
  artifactPath: string,
): PrepareArtifact {
  return loadJsonArtifact(
    artifactPath,
    prepareArtifactSchema,
    CANONICAL_PREPARE_ARTIFACT_LABEL,
  );
}
