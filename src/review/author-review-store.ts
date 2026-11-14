import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  storedAuthorReviewSchema,
  type StoredAuthorReview,
} from "./author-review.js";
import { resolveHumanReviewEventsPath } from "./human-review-store.js";

/** Author reviews sit beside the report's human-review events. */
function resolveAuthorReviewsDir(input: {
  runRoot: string;
  reportArtifactId: string;
}): string {
  return join(dirname(resolveHumanReviewEventsPath(input)), "author-reviews");
}

/** Where `author-review:export` writes the page for a report by default. */
export function resolveAuthorReviewPagePath(input: {
  runRoot: string;
  reportArtifactId: string;
}): string {
  return join(
    dirname(resolveHumanReviewEventsPath(input)),
    "author-review.html",
  );
}

/**
 * Store one import: the answers read from the returned file, and the file
 * itself as the raw input they came from, both named by the import time.
 * Every import is kept.
 */
export function saveAuthorReview(
  runRoot: string,
  review: StoredAuthorReview,
  returnedFile: string,
): string {
  const parsed = storedAuthorReviewSchema.parse(review);
  const stem = join(
    resolveAuthorReviewsDir({
      runRoot,
      reportArtifactId: parsed.lineage.reportArtifactId,
    }),
    parsed.importedAt.replaceAll(":", "-"),
  );
  mkdirSync(dirname(stem), { recursive: true });
  writeFileSync(`${stem}.html`, returnedFile, "utf8");
  writeFileSync(`${stem}.json`, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return `${stem}.json`;
}

/** Every stored author review of one report, oldest first. */
export function loadAuthorReviews(input: {
  runRoot: string;
  reportArtifactId: string;
}): StoredAuthorReview[] {
  const dir = resolveAuthorReviewsDir(input);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      storedAuthorReviewSchema.parse(
        JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown,
      ),
    );
}
