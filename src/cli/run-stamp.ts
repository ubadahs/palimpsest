import { readdirSync } from "node:fs";

/**
 * Generates a run stamp like "2026-03-25_001" — date + incrementing run number.
 * Scans existing files in the output directory to find the next available number.
 */
function maxRunNumberForDate(outputDir: string, today: string): number {
  const prefix = `${today}_`;

  let maxN = 0;
  try {
    for (const entry of readdirSync(outputDir)) {
      if (entry.startsWith(prefix)) {
        const match = /^(\d{4}-\d{2}-\d{2})_(\d{3})/.exec(entry);
        if (match?.[1] === today && match[2] != null) {
          const n = parseInt(match[2], 10);
          if (n > maxN) maxN = n;
        }
      }
    }
  } catch {
    // directory doesn't exist yet — first run
  }

  return maxN;
}

export function nextRunStampFromDirectories(outputDirs: string[]): string {
  const today = new Date().toISOString().slice(0, 10);
  let maxN = 0;

  for (const outputDir of outputDirs) {
    maxN = Math.max(maxN, maxRunNumberForDate(outputDir, today));
  }

  return `${today}_${String(maxN + 1).padStart(3, "0")}`;
}

export function nextRunStamp(outputDir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const prefix = `${today}_`;

  return `${prefix}${String(maxRunNumberForDate(outputDir, today) + 1).padStart(3, "0")}`;
}
