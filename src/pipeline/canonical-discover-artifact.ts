import {
  discoverArtifactSchema,
  type DiscoverArtifact,
} from "../contract/lean-artifacts.js";
import { loadJsonArtifact, writeJsonArtifact } from "../shared/artifact-io.js";

const CANONICAL_DISCOVER_ARTIFACT_LABEL = "canonical Discover";

export function writeCanonicalDiscoverArtifact(
  artifactPath: string,
  artifactInput: DiscoverArtifact,
): void {
  const artifact = discoverArtifactSchema.parse(artifactInput);
  writeJsonArtifact(artifactPath, artifact);
}

export function loadCanonicalDiscoverArtifact(
  artifactPath: string,
): DiscoverArtifact {
  return loadJsonArtifact(
    artifactPath,
    discoverArtifactSchema,
    CANONICAL_DISCOVER_ARTIFACT_LABEL,
  );
}
