/**
 * Ledger of requests submitted through the Message Batches API.
 *
 * A batch is billed once submitted, even if the process that submitted it
 * dies before reading the results. Keeping each request's `custom_id` with
 * its batch id lets a later run take that result instead of paying again.
 *
 * Ownership: this module only records submissions; the batch transport in
 * `integrations/batch-transport.ts` decides when to read and delete rows.
 */

import type Database from "better-sqlite3";

/**
 * The Message Batches API keeps a batch's results for 29 days. A row older
 * than that can no longer be answered from its batch and is resent instead.
 */
export const BATCH_RESULTS_RETENTION_DAYS = 29;

const EXPIRED_WHERE = `julianday(submitted_at) < julianday('now', ? || ' days')`;

/** Rows past the results retention window, which `db:gc` deletes. */
export function countExpiredBatchRequests(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM llm_batch_requests WHERE ${EXPIRED_WHERE}`,
      )
      .get(`-${String(BATCH_RESULTS_RETENTION_DAYS)}`) as { n: number }
  ).n;
}

export function pruneExpiredBatchRequests(db: Database.Database): number {
  return db
    .prepare(`DELETE FROM llm_batch_requests WHERE ${EXPIRED_WHERE}`)
    .run(`-${String(BATCH_RESULTS_RETENTION_DAYS)}`).changes;
}

export type BatchRequestRow = {
  customId: string;
  batchId: string;
  submittedAt: string;
  /** A result line that arrived after its caller was gone, as JSON text. */
  resultJson: string | undefined;
};

export type BatchRequestStore = {
  get: (customId: string) => BatchRequestRow | undefined;
  /** Records one submitted batch; all rows are written or none. */
  recordSubmitted: (
    batchId: string,
    customIds: readonly string[],
    submittedAt: string,
  ) => void;
  storeResult: (customId: string, resultJson: string) => void;
  remove: (customId: string) => void;
};

export function createSqliteBatchRequestStore(
  db: Database.Database,
): BatchRequestStore {
  const select = db.prepare(
    "SELECT custom_id, batch_id, submitted_at, result_json FROM llm_batch_requests WHERE custom_id = ?",
  );
  const insert = db.prepare(
    `INSERT INTO llm_batch_requests (custom_id, batch_id, submitted_at, result_json)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(custom_id) DO UPDATE SET
       batch_id = excluded.batch_id,
       submitted_at = excluded.submitted_at,
       result_json = NULL`,
  );
  const update = db.prepare(
    "UPDATE llm_batch_requests SET result_json = ? WHERE custom_id = ?",
  );
  const remove = db.prepare(
    "DELETE FROM llm_batch_requests WHERE custom_id = ?",
  );
  const recordAll = db.transaction(
    (batchId: string, customIds: readonly string[], submittedAt: string) => {
      for (const customId of customIds) {
        insert.run(customId, batchId, submittedAt);
      }
    },
  );

  return {
    get(customId) {
      const row = select.get(customId) as
        | {
            custom_id: string;
            batch_id: string;
            submitted_at: string;
            result_json: string | null;
          }
        | undefined;
      if (!row) return undefined;
      return {
        customId: row.custom_id,
        batchId: row.batch_id,
        submittedAt: row.submitted_at,
        resultJson: row.result_json ?? undefined,
      };
    },
    recordSubmitted(batchId, customIds, submittedAt) {
      recordAll(batchId, customIds, submittedAt);
    },
    storeResult(customId, resultJson) {
      update.run(resultJson, customId);
    },
    remove(customId) {
      remove.run(customId);
    },
  };
}

/** In-process store for callers without a database; nothing outlives the run. */
export function createMemoryBatchRequestStore(): BatchRequestStore {
  const rows = new Map<string, BatchRequestRow>();
  return {
    get: (customId) => rows.get(customId),
    recordSubmitted(batchId, customIds, submittedAt) {
      for (const customId of customIds) {
        rows.set(customId, {
          customId,
          batchId,
          submittedAt,
          resultJson: undefined,
        });
      }
    },
    storeResult(customId, resultJson) {
      const row = rows.get(customId);
      if (row) rows.set(customId, { ...row, resultJson });
    },
    remove(customId) {
      rows.delete(customId);
    },
  };
}
