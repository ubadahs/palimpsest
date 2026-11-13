/**
 * Store of verified seed codebooks, keyed by seed identity, seed-text content
 * hash, and codebook procedure version.
 *
 * Ownership: this module only reads and writes rows. Scope decides when to
 * reuse one and when to generate a new one (`resolveSeedCodebook`). Unlike
 * the exact-result LLM cache, rows here are scientific state: `db:gc` never
 * deletes them and `--force-refresh` never replaces them.
 */

import type Database from "better-sqlite3";

import {
  storedSeedCodebookSchema,
  type StoredSeedCodebook,
} from "../contract/artifacts/codebook.js";

export type SeedCodebookKey = {
  seedId: string;
  seedTextHash: string;
  procedureVersion: string;
};

export type SeedCodebookStore = {
  get: (key: SeedCodebookKey) => StoredSeedCodebook | undefined;
  /** Inserts the codebook, replacing any row with the same key. */
  put: (codebook: StoredSeedCodebook) => void;
};

export function createSqliteSeedCodebookStore(
  db: Database.Database,
): SeedCodebookStore {
  const select = db.prepare(
    `SELECT codebook_json FROM seed_codebooks
     WHERE seed_id = ? AND seed_text_hash = ? AND procedure_version = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO seed_codebooks
       (seed_id, seed_text_hash, procedure_version, codebook_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(seed_id, seed_text_hash, procedure_version) DO UPDATE SET
       codebook_json = excluded.codebook_json,
       created_at = excluded.created_at`,
  );
  return {
    get(key) {
      const row = select.get(
        key.seedId,
        key.seedTextHash,
        key.procedureVersion,
      ) as { codebook_json: string } | undefined;
      if (!row) return undefined;
      // A row that no longer parses was written by other code; it is a
      // programmer error to keep using it, not a miss to paper over.
      return storedSeedCodebookSchema.parse(JSON.parse(row.codebook_json));
    },
    put(codebook) {
      const parsed = storedSeedCodebookSchema.parse(codebook);
      upsert.run(
        parsed.seedId,
        parsed.seedTextHash,
        parsed.procedureVersion,
        JSON.stringify(parsed),
        parsed.generatedAt,
      );
    },
  };
}
