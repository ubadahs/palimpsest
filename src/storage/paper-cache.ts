import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type { CachePolicy } from "../domain/classification.js";
import type { ParsedPaperParserKind } from "../domain/parsing.js";

/**
 * The raw acquisition result, keyed by paper. Provider metadata is re-resolved
 * on every run, so only what the retrieval layer reads back is stored.
 */
export type CachedPaper = {
  paperId: string;
  rawFullText?: string | undefined;
  fullTextFormat?: string | undefined;
  contentHash?: string | undefined;
  acquisitionProvenanceJson?: string | undefined;
};

export type ParsedPaperData = {
  paperId: string;
  parserVersion: string;
  parserKind: ParsedPaperParserKind;
  contentHash: string;
  refsJson?: string | undefined;
  chunksJson?: string | undefined;
  mentionsJson?: string | undefined;
  parsedAt: string;
};

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
    rawFullText: row["raw_full_text"] as string | undefined,
    fullTextFormat: row["full_text_format"] as string | undefined,
    contentHash: row["content_hash"] as string | undefined,
    acquisitionProvenanceJson: row["acquisition_provenance_json"] as
      | string
      | undefined,
  };
}

export function upsertRawPaper(
  db: Database.Database,
  paper: CachedPaper,
): void {
  db.prepare(
    `
    INSERT INTO paper_cache (
      paper_id, raw_full_text, full_text_format, content_hash,
      acquisition_provenance_json
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(paper_id) DO UPDATE SET
      raw_full_text = excluded.raw_full_text,
      full_text_format = excluded.full_text_format,
      content_hash = excluded.content_hash,
      acquisition_provenance_json = excluded.acquisition_provenance_json
  `,
  ).run(
    paper.paperId,
    paper.rawFullText ?? null,
    paper.fullTextFormat ?? null,
    paper.contentHash ?? null,
    paper.acquisitionProvenanceJson ?? null,
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
      refs_json, chunks_json, mentions_json, parsed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(paper_id) DO UPDATE SET
      parser_version = excluded.parser_version,
      parser_kind = excluded.parser_kind,
      content_hash = excluded.content_hash,
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

export function computeContentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").substring(0, 16);
}
