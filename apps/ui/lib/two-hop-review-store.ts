import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  priorReviewSchema,
  saveTwoHopReviewSchema,
  twoHopStudySchema,
  type TwoHopAnswer,
  type TwoHopReviewData,
} from "./two-hop-review-types";

export class ReviewConflict extends Error {}
export class ReviewPacketMissing extends Error {}
export class UnknownReviewCase extends Error {}

const eventSchema = saveTwoHopReviewSchema.extend({
  revision: z.string(),
  savedAt: z.iso.datetime(),
});

function loadStudy(directory: string) {
  const path = join(directory, "study.json");
  if (!existsSync(path))
    throw new ReviewPacketMissing(
      "No local two-hop review packet has been prepared.",
    );
  const packet = twoHopStudySchema.parse(
    JSON.parse(readFileSync(path, "utf8")),
  );
  const studyRevision = createHash("sha256")
    .update(JSON.stringify(packet))
    .digest("hex");
  return { ...packet, studyRevision };
}

function latestEvent(directory: string) {
  if (!existsSync(directory)) return null;
  const versions = readdirSync(directory)
    .filter((file) => /^[1-9]\d*\.json$/.test(file))
    .map((file) => Number.parseInt(file, 10));
  if (versions.length === 0) return null;
  const revision = String(Math.max(...versions));
  return eventSchema.parse(
    JSON.parse(readFileSync(join(directory, revision + ".json"), "utf8")),
  );
}

export function loadTwoHopReview(directory: string): TwoHopReviewData {
  const study = loadStudy(directory);
  const answers: Record<string, TwoHopAnswer> = {};
  const revisions: Record<string, string> = {};
  const priorReviews: TwoHopReviewData["priorReviews"] = {};
  const history = join(directory, "history", study.studyRevision + ".json");
  const previous = existsSync(history)
    ? z
        .record(z.string(), priorReviewSchema)
        .parse(JSON.parse(readFileSync(history, "utf8")))
    : {};
  for (const { caseId } of study.cases) {
    const prior = previous[caseId];
    if (prior) {
      const path = join(
        directory,
        "answers",
        prior.sourceStudyRevision,
        caseId,
        prior.sourceRevision + ".json",
      );
      const saved = eventSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (
        saved.caseId !== caseId ||
        saved.studyRevision !== prior.sourceStudyRevision ||
        saved.revision !== prior.sourceRevision
      )
        throw new Error(
          "Previous review event does not match its recorded identity.",
        );
      priorReviews[caseId] = { ...prior, answer: saved.answer };
      if (prior.scope === "previous_chain_question")
        answers[caseId] = saved.answer;
    }
    const event = latestEvent(
      join(directory, "answers", study.studyRevision, caseId),
    );
    if (event) {
      answers[caseId] = event.answer;
      revisions[caseId] = event.revision;
    }
  }
  return { ...study, answers, revisions, priorReviews };
}

export function saveTwoHopReview(
  directory: string,
  request: z.infer<typeof saveTwoHopReviewSchema>,
) {
  const study = loadStudy(directory);
  if (study.studyRevision !== request.studyRevision)
    throw new ReviewConflict("Source packet changed. Reload before saving.");
  if (!study.cases.some((c) => c.caseId === request.caseId))
    throw new UnknownReviewCase("Unknown review case.");

  const caseDir = join(
    directory,
    "answers",
    study.studyRevision,
    request.caseId,
  );
  const head = latestEvent(caseDir);
  const conflict = () =>
    new ReviewConflict(
      "Another tab saved this case. Reload to review the latest answer.",
    );
  if ((head?.revision ?? null) !== request.expectedRevision) throw conflict();
  const revision = String(Number(request.expectedRevision) + 1);
  const event = { ...request, revision, savedAt: new Date().toISOString() };
  mkdirSync(caseDir, { recursive: true });
  const temporary = join(caseDir, randomUUID() + ".tmp");
  writeFileSync(temporary, JSON.stringify(event, null, 2) + "\n", {
    flag: "wx",
    flush: true,
  });
  try {
    // Publish only complete events. Competing saves for this revision cannot replace each other.
    linkSync(temporary, join(caseDir, revision + ".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict();
    throw error;
  } finally {
    unlinkSync(temporary);
  }
  return { answer: event.answer, revision };
}
