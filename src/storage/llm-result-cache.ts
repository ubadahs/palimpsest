/**
 * Persistent exact-result cache for LLM calls.
 *
 * Keyed by SHA-256 over canonical request data so that identical requests
 * (same purpose, model, prompt, thinking config, schema version) return
 * the same response without hitting the provider.
 *
 * Ownership: this module handles LLM result reuse only.
 * Paper acquisition caching stays in paper-cache.ts.
 */

import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type { LLMPurpose } from "../integrations/llm-client.js";

// ---------------------------------------------------------------------------
// Cache key computation
// ---------------------------------------------------------------------------

export type LLMCacheKeyInput = {
  purpose: LLMPurpose;
  model: string;
  /** Full prompt text (or promptPrefix + promptSuffix concatenated). */
  prompt: string;
  /** Stringified thinking config, or empty string if disabled. */
  thinkingConfig: string;
  /**
   * Purpose-specific version string. Bump when prompt template or
   * output schema changes to auto-invalidate stale entries.
   */
  keyVersion: string;
  /**
   * Optional fingerprint of the output Zod schema. Included for
   * generateObject() calls so that the same prompt with different
   * schemas produces distinct cache keys.
   */
  schemaFingerprint?: string;
};

export function computeLLMCacheKey(input: LLMCacheKeyInput): string {
  const payload = [
    input.purpose,
    input.model,
    input.prompt,
    input.thinkingConfig,
    input.keyVersion,
    input.schemaFingerprint ?? "",
  ].join("\0");

  return createHash("sha256").update(payload).digest("hex");
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export type CachedLLMResult = {
  cacheKey: string;
  purpose: LLMPurpose;
  model: string;
  keyVersion: string;
  responseText: string;
  createdAt: string;
  lastHitAt: string | undefined;
};

export function getCachedLLMResult(
  db: Database.Database,
  cacheKey: string,
): CachedLLMResult | undefined {
  const row = db
    .prepare("SELECT * FROM llm_result_cache WHERE cache_key = ?")
    .get(cacheKey) as Record<string, unknown> | undefined;

  if (!row) return undefined;

  // Touch last_hit_at on read so we can measure reuse.
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE llm_result_cache SET last_hit_at = ? WHERE cache_key = ?",
  ).run(now, cacheKey);

  return {
    cacheKey: row["cache_key"] as string,
    purpose: row["purpose"] as LLMPurpose,
    model: row["model"] as string,
    keyVersion: row["key_version"] as string,
    responseText: row["response_text"] as string,
    createdAt: row["created_at"] as string,
    lastHitAt: now,
  };
}

export function storeLLMResult(
  db: Database.Database,
  entry: Omit<CachedLLMResult, "lastHitAt">,
): void {
  db.prepare(
    `INSERT INTO llm_result_cache (cache_key, purpose, model, key_version, response_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       response_text = excluded.response_text,
       created_at = excluded.created_at`,
  ).run(
    entry.cacheKey,
    entry.purpose,
    entry.model,
    entry.keyVersion,
    entry.responseText,
    entry.createdAt,
  );
}
