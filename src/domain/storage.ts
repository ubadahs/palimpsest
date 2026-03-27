import { z } from "zod";

import { undefinedable } from "./common.js";
import { confidenceSchema } from "./extraction.js";

export const cachedPaperSchema = z
  .object({
    paperId: z.string().min(1),
    doi: undefinedable(z.string()),
    openalexId: undefinedable(z.string()),
    pmcid: undefinedable(z.string()),
    title: z.string().min(1),
    authorsJson: undefinedable(z.string()),
    accessStatus: z.string().min(1),
    rawFullText: undefinedable(z.string()),
    fullTextFormat: undefinedable(z.string()),
    fetchSourceUrl: undefinedable(z.string()),
    fetchStatus: z.string().min(1),
    contentHash: undefinedable(z.string()),
    fetchedAt: z.string().min(1),
    metadataJson: undefinedable(z.string()),
  })
  .passthrough();
export type CachedPaper = z.infer<typeof cachedPaperSchema>;

export const parsedPaperDataSchema = z
  .object({
    paperId: z.string().min(1),
    parserVersion: z.string().min(1),
    sectionsJson: undefinedable(z.string()),
    refsJson: undefinedable(z.string()),
    chunksJson: undefinedable(z.string()),
    parsedAt: z.string().min(1),
  })
  .passthrough();
export type ParsedPaperData = z.infer<typeof parsedPaperDataSchema>;

export const derivedArtifactSchema = z
  .object({
    artifactId: z.string().min(1),
    paperId: z.string().min(1),
    artifactType: z.enum([
      "candidate_claim",
      "section_summary",
      "chunk_embedding",
    ]),
    generator: z.string().min(1),
    createdAt: z.string().min(1),
    sourceSpanIds: z.array(z.string()),
    confidence: confidenceSchema,
    status: z.literal("provisional"),
    content: z.string(),
  })
  .passthrough();
export type DerivedArtifact = z.infer<typeof derivedArtifactSchema>;
