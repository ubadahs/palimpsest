/**
 * The Report's codebook view: per seed codebook entry and theme, the citing
 * claim units tagged with it and the verdicts of their adjudicated records.
 *
 * Joins Scope's claim tags to Adjudicate's outcomes through the claim record
 * ids each adjudicated outcome already records (`evaluatedClaimRecordIds`).
 * It reads and counts only: no family, record, or verdict changes.
 */
import { normalizeDiscoverClaimText } from "../../contract/claim-unit.js";
import {
  isUsableCodebook,
  type AdjudicateArtifact,
  type DiscoverArtifact,
  type ReportCodebookCounts,
  type ReportSeedCodebook,
  type ScopeArtifact,
  type ScopeClaimTag,
} from "../../contract/artifacts/index.js";
import { compareCodeUnits } from "../../shared/order.js";

type Verdict = "F" | "D" | "E" | "U";

class Tally {
  readonly units = new Set<string>();
  readonly records = new Set<string>();
  readonly verdicts: Record<Verdict, number> = { F: 0, D: 0, E: 0, U: 0 };

  addRecord(recordId: string, verdict: Verdict): void {
    if (this.records.has(recordId)) return;
    this.records.add(recordId);
    this.verdicts[verdict] += 1;
  }

  counts(): ReportCodebookCounts {
    return {
      taggedClaimUnits: this.units.size,
      adjudicatedRecords: this.records.size,
      ...this.verdicts,
    };
  }
}

export function buildSeedCodebookViews(input: {
  discoverArtifact: DiscoverArtifact;
  scopeArtifact: ScopeArtifact;
  adjudicateArtifact: AdjudicateArtifact;
}): ReportSeedCodebook[] {
  const discover = input.discoverArtifact.payload;
  const scope = input.scopeArtifact.payload;

  const tagByClaimId = new Map<string, ScopeClaimTag>(
    scope.claimTags.map((tag) => [tag.claimRecordId, tag]),
  );
  if (
    tagByClaimId.size !== discover.attributedClaimRecords.length ||
    discover.attributedClaimRecords.some(
      (claim) => !tagByClaimId.has(claim.claimRecordId),
    )
  ) {
    throw new Error(
      "Scope claim tags must account for every Discover attributed claim exactly once",
    );
  }
  const citingPaperByMentionId = new Map(
    discover.citationMentions.map((mention) => [
      mention.mentionId,
      mention.citingPaperRecordId,
    ]),
  );
  const seedIdByFamilyId = new Map(
    scope.families.map((family) => [family.familyId, family.seedId]),
  );

  const views: ReportSeedCodebook[] = [];
  for (const codebook of [...scope.codebooks].sort((left, right) =>
    compareCodeUnits(left.seedId, right.seedId),
  )) {
    const seed = discover.seeds.find(
      (entry) => entry.seedId === codebook.seedId,
    );
    if (!seed) {
      throw new Error(
        `Scope codebook names an unknown seed: ${codebook.seedId}`,
      );
    }
    const seedClaims = discover.attributedClaimRecords.filter(
      (claim) => claim.seedId === codebook.seedId,
    );
    const claimSummary = {
      total: seedClaims.length,
      specific: 0,
      themeOnly: 0,
      none: 0,
      taggingFailed: 0,
      notTagged: 0,
    };
    for (const claim of seedClaims) {
      const tag = tagByClaimId.get(claim.claimRecordId)!;
      if (tag.status === "tagging_failed") claimSummary.taggingFailed += 1;
      else if (tag.status === "not_tagged") claimSummary.notTagged += 1;
      else if (tag.kind === "specific") claimSummary.specific += 1;
      else if (tag.kind === "theme_only") claimSummary.themeOnly += 1;
      else claimSummary.none += 1;
    }

    const themes = isUsableCodebook(codebook) ? codebook.themes : [];
    const entries = isUsableCodebook(codebook) ? codebook.entries : [];
    const themeOfEntry = new Map(
      entries.map((entry) => [entry.entryId, entry.themeId]),
    );
    const tagsOfClaim = (claimRecordId: string): string[] => {
      const tag = tagByClaimId.get(claimRecordId);
      return tag?.status === "tagged" ? tag.tags : [];
    };
    /** Themes a tag set rolls up to: the theme itself, or an entry's parent. */
    const themesOf = (tags: Iterable<string>): Set<string> => {
      const rolled = new Set<string>();
      for (const tag of tags) rolled.add(themeOfEntry.get(tag) ?? tag);
      return rolled;
    };

    const entryTallies = new Map(
      entries.map((entry) => [entry.entryId, new Tally()]),
    );
    const themeTallies = new Map(
      themes.map((theme) => [theme.themeId, new Tally()]),
    );
    const themeOnlyUnits = new Map(
      themes.map((theme) => [theme.themeId, new Set<string>()]),
    );
    const entryUnits = new Map(
      themes.map((theme) => [theme.themeId, new Set<string>()]),
    );
    const citedEntryIds = new Set<string>();

    // Claim units: distinct citing paper × normalized claim text.
    const unitTags = new Map<string, Set<string>>();
    for (const claim of seedClaims) {
      const citingPaper = citingPaperByMentionId.get(claim.mentionId);
      if (citingPaper == null) {
        throw new Error(
          `Discover claim names an unknown mention: ${claim.claimRecordId}`,
        );
      }
      const unitKey = `${citingPaper}\u0000${normalizeDiscoverClaimText(claim.extractedClaimText)}`;
      const set = unitTags.get(unitKey) ?? new Set<string>();
      for (const tag of tagsOfClaim(claim.claimRecordId)) set.add(tag);
      unitTags.set(unitKey, set);
    }
    let untaggedUnits = 0;
    for (const [unitKey, tags] of unitTags) {
      if (tags.size === 0) untaggedUnits += 1;
      for (const tag of tags) {
        const entryTally = entryTallies.get(tag);
        if (entryTally) {
          entryTally.units.add(unitKey);
          citedEntryIds.add(tag);
          entryUnits.get(themeOfEntry.get(tag)!)?.add(unitKey);
        } else {
          themeOnlyUnits.get(tag)?.add(unitKey);
        }
      }
      for (const themeId of themesOf(tags)) {
        themeTallies.get(themeId)?.units.add(unitKey);
      }
    }

    // Adjudicated records: tagged by their evaluated claims.
    let adjudicatedTotal = 0;
    let adjudicatedUntagged = 0;
    for (const record of input.adjudicateArtifact.payload.records) {
      if (record.status !== "adjudicated") continue;
      if (seedIdByFamilyId.get(record.familyId) !== codebook.seedId) continue;
      adjudicatedTotal += 1;
      const tags = new Set(record.evaluatedClaimRecordIds.flatMap(tagsOfClaim));
      if (tags.size === 0) adjudicatedUntagged += 1;
      for (const tag of tags) {
        entryTallies.get(tag)?.addRecord(record.recordId, record.verdict);
      }
      for (const themeId of themesOf(tags)) {
        themeTallies.get(themeId)?.addRecord(record.recordId, record.verdict);
      }
    }

    const resolved =
      seed.resolution.status === "resolved" ? seed.resolution.paper : undefined;
    views.push({
      seedId: codebook.seedId,
      seedDoi: seed.doi,
      ...(resolved ? { seedTitle: resolved.title } : {}),
      codebookStatus: codebook.status,
      ...(isUsableCodebook(codebook)
        ? {
            codebookId: codebook.codebookId,
            procedureVersion: codebook.procedureVersion,
            generatedAt: codebook.generatedAt,
            ...(codebook.generatedInRunId != null
              ? { generatedInRunId: codebook.generatedInRunId }
              : {}),
          }
        : codebook.status === "failed"
          ? {
              procedureVersion: codebook.procedureVersion,
              unavailableReason: `${codebook.failure.code}: ${codebook.failure.reason}`,
            }
          : { unavailableReason: codebook.reason }),
      themes: themes.map((theme) => ({
        themeId: theme.themeId,
        statement: theme.statement,
        isHeadline: theme.isHeadline,
        entryIds: entries
          .filter((entry) => entry.themeId === theme.themeId)
          .map((entry) => entry.entryId),
        counts: themeTallies.get(theme.themeId)!.counts(),
        themeOnlyClaimUnits: themeOnlyUnits.get(theme.themeId)!.size,
        entryClaimUnits: entryUnits.get(theme.themeId)!.size,
      })),
      entries: entries.map((entry) => ({
        entryId: entry.entryId,
        themeId: entry.themeId,
        statement: entry.statement,
        type: entry.type,
        attributedToOtherWork: entry.attributedToOtherWork,
        counts: entryTallies.get(entry.entryId)!.counts(),
      })),
      claims: claimSummary,
      claimUnits: { total: unitTags.size, untagged: untaggedUnits },
      adjudicatedRecords: {
        total: adjudicatedTotal,
        untagged: adjudicatedUntagged,
      },
      uncitedEntryIds: entries
        .map((entry) => entry.entryId)
        .filter((entryId) => !citedEntryIds.has(entryId)),
    });
  }
  return views;
}
