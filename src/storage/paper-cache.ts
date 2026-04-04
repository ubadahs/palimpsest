import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  CachedPaper,
  CachePolicy,
  DerivedArtifact,
  ParsedPaperData,
} from "../domain/types.js";

export function getCachedPaper(
  db: Database.Database,
  paperId: string,
  policy: CachePolicy,
): CachedPaper | undefined {
  if (policy === "force_refresh") return undefined;

  const row = db
    .prepare("SELECT * FROM paper_cache WHERE paper_id = ?")
    .get(paperId) as Record<string, unknown> | undefined;

  if (!row) return undefined;

  return {
    paperId: row["paper_id"] as string,
    doi: row["doi"] as string | undefined,
    openalexId: row["openalex_id"] as string | undefined,
    pmcid: row["pmcid"] as string | undefined,
    title: row["title"] as string,
    authorsJson: row["authors_json"] as string | undefined,
    accessStatus: row["access_status"] as string,
    rawFullText: row["raw_full_text"] as string | undefined,
    fullTextFormat: row["full_text_format"] as string | undefined,
    fetchSourceUrl: row["fetch_source_url"] as string | undefined,
    fetchStatus: row["fetch_status"] as string,
    contentHash: row["content_hash"] as string | undefined,
    fetchedAt: row["fetched_at"] as string,
    metadataJson: row["metadata_json"] as string | undefined,
  };
}

export function upsertRawPaper(
  db: Database.Database,
  paper: CachedPaper,
): void {
  db.prepare(
    `
    INSERT INTO paper_cache (
      paper_id, doi, openalex_id, pmcid, title, authors_json,
      access_status, raw_full_text, full_text_format,
      fetch_source_url, fetch_status, content_hash, fetched_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(paper_id) DO UPDATE SET
      raw_full_text = excluded.raw_full_text,
      full_text_format = excluded.full_text_format,
      fetch_source_url = excluded.fetch_source_url,
      fetch_status = excluded.fetch_status,
      content_hash = excluded.content_hash,
      fetched_at = excluded.fetched_at,
      metadata_json = excluded.metadata_json
  `,
  ).run(
    paper.paperId,
    paper.doi ?? null,
    paper.openalexId ?? null,
    paper.pmcid ?? null,
    paper.title,
    paper.authorsJson ?? null,
    paper.accessStatus,
    paper.rawFullText ?? null,
    paper.fullTextFormat ?? null,
    paper.fetchSourceUrl ?? null,
    paper.fetchStatus,
    paper.contentHash ?? null,
    paper.fetchedAt,
    paper.metadataJson ?? null,
  );
}

export function upsertParsedData(
  db: Database.Database,
  parsed: ParsedPaperData,
): void {
  db.prepare(
    `
    INSERT INTO paper_parsed (
      paper_id, parser_version, parser_kind, content_hash,
      sections_json, refs_json, chunks_json, mentions_json, parsed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(paper_id) DO UPDATE SET
      parser_version = excluded.parser_version,
      parser_kind = excluded.parser_kind,
      content_hash = excluded.content_hash,
      sections_json = excluded.sections_json,
      refs_json = excluded.refs_json,
      chunks_json = excluded.chunks_json,
      mentions_json = excluded.mentions_json,
      parsed_at = excluded.parsed_at
  `,
  ).run(
    parsed.paperId,
    parsed.parserVersion,
    parsed.parserKind,
    parsed.contentHash,
    parsed.sectionsJson ?? null,
    parsed.refsJson ?? null,
    parsed.chunksJson ?? null,
    parsed.mentionsJson ?? null,
    parsed.parsedAt,
  );
}

export function getParsedPaper(
  db: Database.Database,
  paperId: string,
  parserVersion: string,
  contentHash: string,
): ParsedPaperData | undefined {
  const row = db
    .prepare("SELECT * FROM paper_parsed WHERE paper_id = ?")
    .get(paperId) as Record<string, unknown> | undefined;

  if (!row) {
    return undefined;
  }

  const cached: ParsedPaperData = {
    paperId: row["paper_id"] as string,
    parserVersion: row["parser_version"] as string,
    parserKind: row["parser_kind"] as ParsedPaperData["parserKind"],
    contentHash: row["content_hash"] as string,
    sectionsJson: row["sections_json"] as string | undefined,
    refsJson: row["refs_json"] as string | undefined,
    chunksJson: row["chunks_json"] as string | undefined,
    mentionsJson: row["mentions_json"] as string | undefined,
    parsedAt: row["parsed_at"] as string,
  };

  if (
    cached.parserVersion !== parserVersion ||
    cached.contentHash !== contentHash ||
    !cached.parserKind
  ) {
    return undefined;
  }

  return cached;
}

export function storeDerivedArtifact(
  db: Database.Database,
  artifact: DerivedArtifact,
): void {
  db.prepare(
    `
    INSERT INTO derived_artifacts (
      artifact_id, paper_id, artifact_type, generator, created_at,
      source_span_ids_json, confidence, status, content
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    artifact.artifactId,
    artifact.paperId,
    artifact.artifactType,
    artifact.generator,
    artifact.createdAt,
    JSON.stringify(artifact.sourceSpanIds),
    artifact.confidence,
    artifact.status,
    artifact.content,
  );
}

export function getDerivedArtifacts(
  db: Database.Database,
  paperId: string,
): DerivedArtifact[] {
  const rows = db
    .prepare("SELECT * FROM derived_artifacts WHERE paper_id = ?")
    .all(paperId) as Record<string, unknown>[];

  return rows.map((row) => ({
    artifactId: row["artifact_id"] as string,
    paperId: row["paper_id"] as string,
    artifactType: row["artifact_type"] as DerivedArtifact["artifactType"],
    generator: row["generator"] as string,
    createdAt: row["created_at"] as string,
    sourceSpanIds: JSON.parse(
      (row["source_span_ids_json"] as string) ?? "[]",
    ) as string[],
    confidence: row["confidence"] as DerivedArtifact["confidence"],
    status: "provisional" as const,
    content: row["content"] as string,
  }));
}

export function computeContentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").substring(0, 16);
}
