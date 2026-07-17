import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  artifactReferenceSchema,
  type ArtifactReference,
} from "../contract/lean-artifact-primitives.js";
import {
  buildStableId,
  canonicalSerialize,
  canonicalSha256,
} from "../shared/stable-identity.js";

/**
 * Persist immutable normalized request/response bodies under a run-scoped
 * content-addressed provenance directory.
 *
 * Filesystem URIs are never part of artifact identity: references use a stable
 * `content-hash://` URI derived only from the body digest.
 */
export type CanonicalProvenanceStore = {
  readonly rootDirectory: string;
  persist(input: {
    role: string;
    body: unknown;
    canonicalStage?: ArtifactReference["canonicalStage"];
  }): ArtifactReference;
  load(reference: ArtifactReference): {
    role: string;
    contentHash: string;
    body: unknown;
  };
  pathFor(reference: ArtifactReference): string;
};

export function createCanonicalProvenanceStore(
  runRoot: string,
): CanonicalProvenanceStore {
  const rootDirectory = resolve(runRoot, "provenance");
  mkdirSync(rootDirectory, { recursive: true });

  return {
    rootDirectory,
    persist({ role, body, canonicalStage }) {
      const serialized = canonicalSerialize(body);
      const contentHash = canonicalSha256(body);
      const artifactId = buildStableId("prov", {
        role,
        contentHash,
      });
      const reference = artifactReferenceSchema.parse({
        artifactId,
        contentHash,
        role,
        ...(canonicalStage != null ? { canonicalStage } : {}),
        uri: `provenance://${artifactId}`,
      });
      const path = resolve(rootDirectory, `${artifactId}.json`);
      const encoded = `${JSON.stringify(
        {
          role,
          contentHash,
          body: JSON.parse(serialized) as unknown,
        },
        null,
        2,
      )}\n`;
      if (existsSync(path)) {
        if (readFileSync(path, "utf8") !== encoded) {
          throw new Error(`Immutable provenance collision for ${artifactId}`);
        }
      } else {
        writeFileSync(path, encoded, { encoding: "utf8", flag: "wx" });
      }
      return reference;
    },
    load(referenceInput) {
      const reference = artifactReferenceSchema.parse(referenceInput);
      const value = JSON.parse(
        readFileSync(
          resolve(rootDirectory, `${reference.artifactId}.json`),
          "utf8",
        ),
      ) as unknown;
      const record = parseProvenanceRecord(value);
      if (
        record.role !== reference.role ||
        record.contentHash !== reference.contentHash ||
        canonicalSha256(record.body) !== reference.contentHash
      ) {
        throw new Error(
          `Provenance content does not match ${reference.artifactId}`,
        );
      }
      return record;
    },
    pathFor(referenceInput) {
      const reference = artifactReferenceSchema.parse(referenceInput);
      return resolve(rootDirectory, `${reference.artifactId}.json`);
    },
  };
}

function parseProvenanceRecord(value: unknown): {
  role: string;
  contentHash: string;
  body: unknown;
} {
  if (
    value == null ||
    typeof value !== "object" ||
    !("role" in value) ||
    typeof value.role !== "string" ||
    !("contentHash" in value) ||
    typeof value.contentHash !== "string" ||
    !("body" in value)
  ) {
    throw new Error("Invalid canonical provenance record");
  }
  return {
    role: value.role,
    contentHash: value.contentHash,
    body: value.body,
  };
}

export function contentAddressedExternalExecution(input: {
  provider: string;
  requestBody: unknown;
  responseBody: unknown;
  store: CanonicalProvenanceStore;
  requestRole: string;
  responseRole: string;
  canonicalStage?: ArtifactReference["canonicalStage"];
}): {
  provider: string;
  requestHash: string;
  requestArtifact: ArtifactReference;
  responseArtifact: ArtifactReference;
} {
  const requestArtifact = input.store.persist({
    role: input.requestRole,
    body: input.requestBody,
    ...(input.canonicalStage != null
      ? { canonicalStage: input.canonicalStage }
      : {}),
  });
  const responseArtifact = input.store.persist({
    role: input.responseRole,
    body: input.responseBody,
    ...(input.canonicalStage != null
      ? { canonicalStage: input.canonicalStage }
      : {}),
  });
  return {
    provider: input.provider,
    requestHash: requestArtifact.contentHash,
    requestArtifact,
    responseArtifact,
  };
}

export function contentAddressedModelExecution(input: {
  provider: string;
  model: string;
  promptId: string;
  promptVersion: string;
  promptText: string;
  requestBody: unknown;
  responseBody: unknown;
  store: CanonicalProvenanceStore;
  requestRole: string;
  responseRole: string;
  requestHash?: string;
  kind?: "model";
  canonicalStage?: ArtifactReference["canonicalStage"];
}): {
  kind: "model";
  provider: string;
  model: string;
  promptId: string;
  promptVersion: string;
  promptContentHash: string;
  requestHash: string;
  requestArtifact: ArtifactReference;
  responseArtifact: ArtifactReference;
} {
  const promptContentHash = canonicalSha256(input.promptText);
  const requestArtifact = input.store.persist({
    role: input.requestRole,
    body: input.requestBody,
    ...(input.canonicalStage != null
      ? { canonicalStage: input.canonicalStage }
      : {}),
  });
  const responseArtifact = input.store.persist({
    role: input.responseRole,
    body: input.responseBody,
    ...(input.canonicalStage != null
      ? { canonicalStage: input.canonicalStage }
      : {}),
  });
  return {
    kind: "model",
    provider: input.provider,
    model: input.model,
    promptId: input.promptId,
    promptVersion: input.promptVersion,
    promptContentHash,
    requestHash: input.requestHash ?? requestArtifact.contentHash,
    requestArtifact,
    responseArtifact,
  };
}
