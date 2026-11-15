/**
 * A kept run is exempt from cleanup: `runs:gc` leaves its superseded attempts
 * and their provenance, and `db:gc` leaves its registry row. A run is kept
 * when later work depends on exactly what it wrote, as a chain link does.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const keepPath = (runRoot: string) => resolve(runRoot, "keep.json");

export function isRunKept(runRoot: string): boolean {
  return existsSync(keepPath(runRoot));
}

/** Keeps a run. The first reason given stays on record. */
export function keepRun(runRoot: string, reason: string): void {
  if (isRunKept(runRoot)) return;
  writeFileSync(
    keepPath(runRoot),
    `${JSON.stringify({ reason, keptAt: new Date().toISOString() }, null, 2)}\n`,
    { flag: "wx", flush: true },
  );
}

export function releaseRun(runRoot: string): void {
  rmSync(keepPath(runRoot), { force: true });
}
