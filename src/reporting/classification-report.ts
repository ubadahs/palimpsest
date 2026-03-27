import type {
  CitationRole,
  ClassifiedMention,
  EdgeEvaluationPacket,
  EvaluationMode,
  EvaluationTask,
  FamilyClassificationResult,
} from "../domain/types.js";
import { CONFIDENCE_SORT_ORDER, truncate } from "./report-utils.js";

export function toClassificationJson(
  result: FamilyClassificationResult,
): string {
  return JSON.stringify(result, null, 2);
}

function roleTag(role: CitationRole): string {
  const tags: Record<CitationRole, string> = {
    substantive_attribution: "[ATTR]",
    background_context: "[BG]",
    methods_materials: "[METH]",
    acknowledgment_or_low_information: "[LOW]",
    unclear: "[?]",
  };
  return tags[role];
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function modifierFlags(p: EdgeEvaluationPacket): string {
  const flags: string[] = [];
  if (p.isReviewMediated) flags.push("review");
  if (p.bundledMentionsCount > 0) flags.push("bundled");
  return flags.length > 0 ? flags.join(", ") : "—";
}

function renderMention(m: ClassifiedMention, edgeTitle: string): string {
  const section = m.sectionTitle ? ` · section: ${m.sectionTitle}` : "";
  const bundled = m.isBundledCitation
    ? ` · bundled(${String(m.bundleSize)})`
    : "";
  const review = m.modifiers.isReviewMediated ? " · review-mediated" : "";
  const signals =
    m.classificationSignals.length > 0
      ? m.classificationSignals.slice(0, 3).join(", ")
      : "no signals";
  return [
    `**${truncate(edgeTitle, 70)}**${section}${bundled}${review}`,
    `${roleTag(m.citationRole)} ${m.citationRole} · confidence: ${m.confidence}`,
    `Signals: ${signals}`,
    `Marker: \`${truncate(m.citationMarker, 60)}\``,
    "",
    `> ${truncate(m.rawContext, 350)}`,
    "",
  ].join("\n");
}

function renderTask(t: EvaluationTask, edgeTitle: string): string {
  const bundled = t.modifiers.isBundled ? " · bundled" : "";
  const review = t.modifiers.isReviewMediated ? " · review-mediated" : "";
  return `| ${truncate(edgeTitle, 40)} | ${roleTag(t.citationRole)} ${t.citationRole} | ${t.evaluationMode} | ${String(t.mentionCount)}${bundled}${review} |`;
}

const REPORT_NOTE =
  "> **Note.** Extraction state and literature structure are reported separately.\n" +
  "> Extraction failures are pipeline outcomes, not properties of the citation ecology.\n" +
  "> Citation roles and modifiers are descriptive, not quality scores.";

export function toClassificationMarkdown(
  result: FamilyClassificationResult,
): string {
  const { extractionState: es, literatureStructure: ls } = result.summary;

  const sections: string[] = [
    "# M3 Citation-Function Classification Report",
    "",
    `## Seed: ${result.resolvedSeedPaperTitle}`,
    `**Tracked claim:** ${result.seed.trackedClaim}`,
    `**Study mode:** ${result.studyMode}`,
    "",
    REPORT_NOTE,
    "",
  ];

  // --- Extraction state ---
  sections.push(
    "## Extraction State",
    "",
    "| Status | Count |",
    "| --- | --- |",
    `| Extracted | ${String(es.extracted)} |`,
    `| Failed | ${String(es.failed)} |`,
    `| Skipped | ${String(es.skipped)} |`,
    `| **Total** | **${String(es.totalEdges)}** |`,
  );

  if (Object.keys(es.failureCountsByOutcome).length > 0) {
    sections.push("", "**Failure breakdown:**");
    for (const [outcome, count] of Object.entries(es.failureCountsByOutcome)) {
      sections.push(`- ${outcome}: ${String(count)}`);
    }
  }

  // --- Literature structure ---
  sections.push(
    "",
    "## Literature Structure",
    "",
    `Edges with mentions: ${String(ls.edgesWithMentions)} · Total mentions: ${String(ls.totalMentions)} · Evaluation tasks: ${String(ls.totalTasks)}`,
    "",
    "### Task distribution by citation role",
    "",
    "| Role | Tasks |",
    "| --- | --- |",
  );
  for (const [role, count] of Object.entries(ls.countsByRole) as [
    CitationRole,
    number,
  ][]) {
    if (count > 0) sections.push(`| ${role} | ${String(count)} |`);
  }

  sections.push(
    "",
    "### Task routing by evaluation mode",
    "",
    "| Mode | Tasks |",
    "| --- | --- |",
  );
  for (const [mode, count] of Object.entries(ls.countsByMode) as [
    EvaluationMode,
    number,
  ][]) {
    if (count > 0) sections.push(`| ${mode} | ${String(count)} |`);
  }

  sections.push(
    "",
    "### Transmission modifiers",
    "",
    "| Modifier | Count | Rate |",
    "| --- | --- | --- |",
    `| Bundled mentions | ${String(ls.bundledMentionCount)} | ${formatPercent(ls.bundledMentionRate)} |`,
    `| Review-mediated edges | ${String(ls.reviewMediatedEdgeCount)} | ${formatPercent(ls.reviewMediatedEdgeRate)} |`,
    `| Manual-review tasks | ${String(ls.manualReviewTaskCount)} | — |`,
  );

  // --- Per-edge task breakdown ---
  sections.push(
    "",
    "## Evaluation Tasks",
    "",
    "| Paper | Role | Eval Mode | Mentions |",
    "| --- | --- | --- | --- |",
  );

  for (const p of result.packets) {
    if (p.tasks.length === 0) continue;
    for (const t of p.tasks) {
      sections.push(renderTask(t, p.citingPaper.title));
    }
  }

  // --- Per-edge overview ---
  sections.push(
    "",
    "## Per-Edge Overview",
    "",
    "| Paper | State | Roles | Modifiers | Mentions | Tasks | Manual? |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const p of result.packets) {
    const roles = p.rolesPresent.map(roleTag).join(" ");
    const manual = p.requiresManualReview ? "yes" : "";
    sections.push(
      `| ${truncate(p.citingPaper.title, 40)} | ${p.extractionState} | ${roles || "—"} | ${modifierFlags(p)} | ${String(p.mentions.length)} | ${String(p.tasks.length)} | ${manual} |`,
    );
  }

  // --- Top substantive mentions ---
  const allSubstantive: {
    packet: EdgeEvaluationPacket;
    mention: ClassifiedMention;
  }[] = [];
  const allUnclear: {
    packet: EdgeEvaluationPacket;
    mention: ClassifiedMention;
  }[] = [];

  for (const p of result.packets) {
    for (const m of p.mentions) {
      if (m.citationRole === "substantive_attribution") {
        allSubstantive.push({ packet: p, mention: m });
      }
      if (m.citationRole === "unclear") {
        allUnclear.push({ packet: p, mention: m });
      }
    }
  }

  allSubstantive.sort(
    (a, b) =>
      CONFIDENCE_SORT_ORDER[a.mention.confidence] -
      CONFIDENCE_SORT_ORDER[b.mention.confidence],
  );

  if (allSubstantive.length > 0) {
    sections.push(
      "",
      `## Substantive Attributions (${String(Math.min(10, allSubstantive.length))} of ${String(allSubstantive.length)})`,
      "",
    );
    for (const { packet, mention } of allSubstantive.slice(0, 10)) {
      sections.push(renderMention(mention, packet.citingPaper.title));
    }
  }

  if (allUnclear.length > 0) {
    sections.push(
      "",
      `## Unclear / Manual Review (${String(Math.min(5, allUnclear.length))} of ${String(allUnclear.length)})`,
      "",
    );
    for (const { packet, mention } of allUnclear.slice(0, 5)) {
      sections.push(renderMention(mention, packet.citingPaper.title));
    }
  }

  return sections.join("\n");
}
