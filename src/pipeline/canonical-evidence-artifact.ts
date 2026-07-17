import {
  evidenceArtifactSchema,
  type EvidenceArtifact,
} from "../contract/lean-artifacts.js";
import { loadJsonArtifact, writeJsonArtifact } from "../shared/artifact-io.js";

const CANONICAL_EVIDENCE_ARTIFACT_LABEL = "canonical Evidence";

export function writeCanonicalEvidenceArtifact(
  artifactPath: string,
  artifactInput: EvidenceArtifact,
): void {
  const artifact = evidenceArtifactSchema.parse(artifactInput);
  writeJsonArtifact(artifactPath, artifact);
}

export function loadCanonicalEvidenceArtifact(
  artifactPath: string,
): EvidenceArtifact {
  return loadJsonArtifact(
    artifactPath,
    evidenceArtifactSchema,
    CANONICAL_EVIDENCE_ARTIFACT_LABEL,
  );
}
