import {
  scopeArtifactSchema,
  type ScopeArtifact,
} from "../contract/lean-artifacts.js";
import { loadJsonArtifact, writeJsonArtifact } from "../shared/artifact-io.js";

const CANONICAL_SCOPE_ARTIFACT_LABEL = "canonical Scope";

export function writeCanonicalScopeArtifact(
  artifactPath: string,
  artifactInput: ScopeArtifact,
): void {
  const artifact = scopeArtifactSchema.parse(artifactInput);
  writeJsonArtifact(artifactPath, artifact);
}

export function loadCanonicalScopeArtifact(
  artifactPath: string,
): ScopeArtifact {
  return loadJsonArtifact(
    artifactPath,
    scopeArtifactSchema,
    CANONICAL_SCOPE_ARTIFACT_LABEL,
  );
}
