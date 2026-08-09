import { readFileSync } from "node:fs";

import { DOMParser } from "@xmldom/xmldom";

import type Database from "better-sqlite3";

import type { CachePolicy } from "../domain/classification.js";
import type {
  FullTextAcquisition,
  ResolvedPaper,
  Result,
} from "../domain/common.js";
import type {
  FullTextFormat,
  ParsedBlockKind,
  ParsedCitationMention,
  ParsedPaperBlock,
  ParsedPaperDocument,
  ParsedPaperReference,
} from "../domain/parsing.js";
import { parsedPaperDocumentSchema } from "../domain/parsing.js";
import {
  acquireFullText,
  classifyAcquisitionAttemptFailure,
  type FullTextAcquisitionFailureCode,
  type FullTextContent,
  type FullTextFetchAdapters,
} from "./fulltext-fetch.js";
import {
  computeContentHash,
  getParsedPaper,
  upsertParsedData,
} from "../storage/paper-cache.js";

export const PARSED_PAPER_PARSER_VERSION = "structured-v3";

type ParsedPaperMaterialized = {
  fullText: FullTextContent;
  acquisition: FullTextAcquisition;
  parsedDocument: ParsedPaperDocument;
};

export type ParsedPaperMaterializeResult =
  | { ok: true; data: ParsedPaperMaterialized }
  | {
      ok: false;
      error: string;
      failureCode: FullTextAcquisitionFailureCode;
      acquisition: FullTextAcquisition | undefined;
    };

export type ParsedPaperCacheOptions = {
  db: Database.Database;
  cachePolicy: CachePolicy;
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getTextContent(node: Node): string {
  return normalizeText(node.textContent ?? "");
}

function getElementsByTagName(parent: Node, tag: string): Element[] {
  const results: Element[] = [];
  const children = (parent as Element).getElementsByTagName(tag);
  for (let i = 0; i < children.length; i++) {
    const el = children.item(i);
    if (el) {
      results.push(el);
    }
  }
  return results;
}

function getDirectChildElements(parent: Element, tagName: string): Element[] {
  const children: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const node = parent.childNodes.item(i);
    if (node?.nodeType === 1 && (node as Element).tagName === tagName) {
      children.push(node as Element);
    }
  }
  return children;
}

function getFirstDirectChild(
  parent: Element,
  tagName: string,
): Element | undefined {
  return getDirectChildElements(parent, tagName)[0];
}

function getFirstElement(parent: Node, tag: string): Element | undefined {
  return getElementsByTagName(parent, tag)[0];
}

function findAncestor(node: Node, tagName: string): Element | undefined {
  let current = node.parentNode;
  while (current) {
    if (current.nodeType === 1 && (current as Element).tagName === tagName) {
      return current as Element;
    }
    current = current.parentNode;
  }
  return undefined;
}

function parseYear(text: string | undefined): number | undefined {
  if (!text) {
    return undefined;
  }
  const match = text.match(/\b(19|20)\d{2}\b/);
  if (!match) {
    return undefined;
  }
  return Number.parseInt(match[0], 10);
}

function findFirstMatchingElement(
  parent: Element,
  tagName: string,
  predicate: (element: Element) => boolean,
): Element | undefined {
  return getElementsByTagName(parent, tagName).find(predicate);
}

type OffsetState = { value: number };

function appendBlock(
  blocks: ParsedPaperBlock[],
  text: string,
  sectionTitle: string | undefined,
  blockKind: ParsedBlockKind,
  offsetState: OffsetState,
): void {
  const normalized = normalizeText(text);
  if (normalized.length < 30) {
    return;
  }

  const blockId = `${blockKind}-${String(blocks.length + 1)}`;
  const charOffsetStart = offsetState.value;
  const charOffsetEnd = charOffsetStart + normalized.length;
  blocks.push({
    blockId,
    text: normalized,
    sectionTitle,
    blockKind,
    charOffsetStart,
    charOffsetEnd,
  });
  offsetState.value = charOffsetEnd + 2;
}

type ParagraphCitationGroup = {
  element: Element;
  targetRefIds: string[];
  citationMarker: string;
  localStart: number;
  localEnd: number;
  locationQuality: ParsedCitationMention["locationQuality"];
};

type TextSegment =
  | { kind: "text"; text: string }
  | { kind: "cite"; element: Element; text: string };

function normalizeWithRawMap(raw: string): {
  normalized: string;
  /** Exclusive end index in normalized string for each raw exclusive end. */
  rawExclusiveToNormExclusive: number[];
} {
  const rawExclusiveToNormExclusive = new Array<number>(raw.length + 1);
  rawExclusiveToNormExclusive[0] = 0;
  let normalized = "";
  let lastWasSpace = true; // trim leading whitespace
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        normalized += " ";
        lastWasSpace = true;
      }
    } else {
      normalized += ch;
      lastWasSpace = false;
    }
    rawExclusiveToNormExclusive[i + 1] = normalized.length;
  }
  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    for (let i = 0; i < rawExclusiveToNormExclusive.length; i++) {
      if (rawExclusiveToNormExclusive[i]! > normalized.length) {
        rawExclusiveToNormExclusive[i] = normalized.length;
      }
    }
  }
  return { normalized, rawExclusiveToNormExclusive };
}

function collectParagraphSegments(
  paragraph: Element,
  isCitation: (el: Element) => boolean,
): TextSegment[] {
  const segs: TextSegment[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      segs.push({ kind: "text", text: node.textContent ?? "" });
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const el = node as Element;
    if (isCitation(el)) {
      segs.push({ kind: "cite", element: el, text: el.textContent ?? "" });
      return;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes.item(i);
      if (child) walk(child);
    }
  };
  walk(paragraph);
  return segs;
}

function locateCitationGroupsInParagraph(
  paragraph: Element,
  isCitation: (el: Element) => boolean,
  readTargetRefIds: (el: Element) => string[],
): { rawContext: string; groups: ParagraphCitationGroup[] } {
  const segs = collectParagraphSegments(paragraph, isCitation);
  const raw = segs.map((seg) => seg.text).join("");
  const { normalized, rawExclusiveToNormExclusive } = normalizeWithRawMap(raw);
  const groups: ParagraphCitationGroup[] = [];
  let rawCursor = 0;
  for (const seg of segs) {
    const rawStart = rawCursor;
    const rawEnd = rawCursor + seg.text.length;
    rawCursor = rawEnd;
    if (seg.kind !== "cite") continue;
    const localStart = rawExclusiveToNormExclusive[rawStart] ?? 0;
    const localEnd = rawExclusiveToNormExclusive[rawEnd] ?? localStart;
    const marker = normalizeText(seg.text);
    const exact =
      marker.length > 0 &&
      localEnd > localStart &&
      normalized.slice(localStart, localEnd) === marker;
    groups.push({
      element: seg.element,
      targetRefIds: readTargetRefIds(seg.element),
      citationMarker: marker.length > 0 ? marker : getTextContent(seg.element),
      localStart,
      localEnd,
      locationQuality: exact ? "exact_dom" : "missing",
    });
  }
  return { rawContext: normalized, groups };
}

function bundleMetadataForGroup(
  groups: readonly ParagraphCitationGroup[],
  groupIndex: number,
): Pick<
  ParsedCitationMention,
  "isBundledCitation" | "bundleSize" | "bundleRefIds" | "bundlePattern"
> {
  const target = groups[groupIndex];
  if (!target || target.locationQuality === "missing") {
    const alone = target?.targetRefIds.filter(Boolean) ?? [];
    return {
      isBundledCitation: alone.length > 1,
      bundleSize: Math.max(1, alone.length),
      bundleRefIds: alone,
      bundlePattern: alone.length > 1 ? "parenthetical_group" : "single",
    };
  }

  const clusterRadius = 80;
  const clustered: ParagraphCitationGroup[] = [];
  for (const group of groups) {
    if (group.locationQuality === "missing") continue;
    if (Math.abs(group.localStart - target.localStart) <= clusterRadius) {
      clustered.push(group);
    }
  }
  const bundleRefIds: string[] = [];
  for (const group of clustered) {
    for (const refId of group.targetRefIds) {
      if (refId && !bundleRefIds.includes(refId)) {
        bundleRefIds.push(refId);
      }
    }
  }
  if (bundleRefIds.length <= 1) {
    return {
      isBundledCitation: false,
      bundleSize: 1,
      bundleRefIds: [],
      bundlePattern: "single",
    };
  }
  return {
    isBundledCitation: true,
    bundleSize: bundleRefIds.length,
    bundleRefIds,
    bundlePattern: "parenthetical_group",
  };
}

function refineBundlePattern(
  rawContext: string,
  target: ParagraphCitationGroup,
  bundle: Pick<
    ParsedCitationMention,
    "isBundledCitation" | "bundleSize" | "bundleRefIds" | "bundlePattern"
  >,
): typeof bundle {
  if (!bundle.isBundledCitation) return bundle;
  const windowStart = Math.max(0, target.localStart - 80);
  const windowEnd = Math.min(rawContext.length, target.localEnd + 80);
  const window = rawContext.slice(windowStart, windowEnd);
  return {
    ...bundle,
    bundlePattern: window.includes(";")
      ? "semicolon_separated"
      : "parenthetical_group",
  };
}

function matchBlockIdForParagraph(
  blocks: readonly ParsedPaperBlock[],
  rawContext: string,
): string | undefined {
  const matches = blocks.filter((block) => block.text === rawContext);
  if (matches.length === 1) return matches[0]!.blockId;
  // Prefer body paragraphs when abstracts share text.
  const body = matches.find((block) => block.blockKind === "body_paragraph");
  return body?.blockId ?? matches[0]?.blockId;
}

function buildSourceLocator(
  blockId: string | undefined,
  citationGroupOrdinal: number,
): ParsedCitationMention["sourceLocator"] {
  if (!blockId) return undefined;
  return {
    kind: "block_id",
    value: `${blockId}#cg-${String(citationGroupOrdinal)}`,
  };
}

function buildParsedCitationMention(input: {
  mentionIndex: number;
  rawContext: string;
  citationMarker: string;
  sectionTitle: string | undefined;
  targetRefIds: string[];
  charOffsetStart: number | undefined;
  charOffsetEnd: number | undefined;
  locationQuality: ParsedCitationMention["locationQuality"];
  sourceLocator: ParsedCitationMention["sourceLocator"];
  blockId: string | undefined;
  citationGroupOrdinal: number;
  bundle: Pick<
    ParsedCitationMention,
    "isBundledCitation" | "bundleSize" | "bundleRefIds" | "bundlePattern"
  >;
  sourceType: ParsedCitationMention["sourceType"];
  parser: string;
}): ParsedCitationMention {
  return {
    mentionIndex: input.mentionIndex,
    rawContext: input.rawContext,
    citationMarker: input.citationMarker,
    sectionTitle: input.sectionTitle,
    refId: input.targetRefIds[0],
    targetRefIds: input.targetRefIds,
    charOffsetStart: input.charOffsetStart,
    charOffsetEnd: input.charOffsetEnd,
    locationQuality: input.locationQuality,
    sourceLocator: input.sourceLocator,
    blockId: input.blockId,
    citationGroupOrdinal: input.citationGroupOrdinal,
    isBundledCitation: input.bundle.isBundledCitation,
    bundleSize: input.bundle.bundleSize,
    bundleRefIds: input.bundle.bundleRefIds,
    bundlePattern: input.bundle.bundlePattern,
    sourceType: input.sourceType,
    parser: input.parser,
  };
}

function parseJatsReferences(doc: Document): ParsedPaperReference[] {
  const references: ParsedPaperReference[] = [];

  for (const refEl of getElementsByTagName(doc, "ref")) {
    const refId = refEl.getAttribute("id") ?? "";
    if (!refId) {
      continue;
    }

    const doiEl = findFirstMatchingElement(
      refEl,
      "pub-id",
      (el) => el.getAttribute("pub-id-type") === "doi",
    );
    const pmcidEl = findFirstMatchingElement(
      refEl,
      "pub-id",
      (el) => el.getAttribute("pub-id-type") === "pmcid",
    );
    const pmidEl = findFirstMatchingElement(
      refEl,
      "pub-id",
      (el) => el.getAttribute("pub-id-type") === "pmid",
    );
    const yearEl = getFirstElement(refEl, "year");
    const titleEl = getFirstElement(refEl, "article-title");
    const labelEl = getFirstElement(refEl, "label");
    const surnames = getElementsByTagName(refEl, "surname").map(getTextContent);

    references.push({
      refId,
      doi: doiEl ? getTextContent(doiEl) : undefined,
      pmcid: pmcidEl ? getTextContent(pmcidEl) : undefined,
      pmid: pmidEl ? getTextContent(pmidEl) : undefined,
      year: parseYear(yearEl ? getTextContent(yearEl) : undefined),
      title: titleEl ? getTextContent(titleEl) : undefined,
      label: labelEl ? getTextContent(labelEl) : undefined,
      authorSurnames: surnames,
    });
  }

  return references;
}

function getJatsSectionTitle(node: Node): string | undefined {
  const sec = findAncestor(node, "sec");
  if (!sec) {
    return undefined;
  }
  const titleEl = getFirstDirectChild(sec, "title");
  return titleEl ? getTextContent(titleEl) : undefined;
}

function isJatsBibrXref(el: Element): boolean {
  return el.tagName === "xref" && el.getAttribute("ref-type") === "bibr";
}

function readJatsTargetRefIds(el: Element): string[] {
  return (el.getAttribute("rid") ?? "").split(/\s+/).filter(Boolean);
}

function parseJatsMentions(
  doc: Document,
  blocks: readonly ParsedPaperBlock[],
): ParsedCitationMention[] {
  const bodyEl = getFirstElement(doc, "body");
  if (!bodyEl) {
    return [];
  }

  const mentions: ParsedCitationMention[] = [];
  let mentionIndex = 0;
  const seenParagraphs = new Set<Element>();

  for (const xref of getElementsByTagName(bodyEl, "xref")) {
    if (!isJatsBibrXref(xref)) continue;
    const paragraph = findAncestor(xref, "p");
    if (!paragraph || seenParagraphs.has(paragraph)) continue;
    seenParagraphs.add(paragraph);

    const { rawContext, groups } = locateCitationGroupsInParagraph(
      paragraph,
      isJatsBibrXref,
      readJatsTargetRefIds,
    );
    const blockId = matchBlockIdForParagraph(blocks, rawContext);
    const block = blocks.find((entry) => entry.blockId === blockId);

    for (let groupOrdinal = 0; groupOrdinal < groups.length; groupOrdinal++) {
      const group = groups[groupOrdinal]!;
      const bundle = refineBundlePattern(
        rawContext,
        group,
        bundleMetadataForGroup(groups, groupOrdinal),
      );
      const absoluteStart =
        block && group.locationQuality === "exact_dom"
          ? block.charOffsetStart + group.localStart
          : undefined;
      const absoluteEnd =
        block && group.locationQuality === "exact_dom"
          ? block.charOffsetStart + group.localEnd
          : undefined;
      const sourceLocator = buildSourceLocator(blockId, groupOrdinal);
      mentions.push(
        buildParsedCitationMention({
          mentionIndex,
          rawContext,
          citationMarker: group.citationMarker,
          sectionTitle: getJatsSectionTitle(group.element),
          targetRefIds: group.targetRefIds,
          charOffsetStart: absoluteStart,
          charOffsetEnd: absoluteEnd,
          locationQuality:
            absoluteStart != null && absoluteEnd != null
              ? "exact_dom"
              : sourceLocator
                ? "approximate"
                : "missing",
          sourceLocator,
          blockId,
          citationGroupOrdinal: groupOrdinal,
          bundle,
          sourceType: "jats_xml",
          parser: "jats-normalized",
        }),
      );
      mentionIndex++;
    }
  }

  return mentions;
}

function walkJatsSection(
  section: Element,
  inheritedTitle: string | undefined,
  blocks: ParsedPaperBlock[],
  offsetState: OffsetState,
): void {
  const sectionTitle =
    normalizeText(getFirstDirectChild(section, "title")?.textContent ?? "") ||
    inheritedTitle;

  for (let i = 0; i < section.childNodes.length; i++) {
    const node = section.childNodes.item(i);
    if (node?.nodeType !== 1) {
      continue;
    }

    const element = node as Element;
    if (element.tagName === "sec") {
      walkJatsSection(element, sectionTitle, blocks, offsetState);
      continue;
    }

    if (element.tagName === "p") {
      appendBlock(
        blocks,
        element.textContent ?? "",
        sectionTitle,
        "body_paragraph",
        offsetState,
      );
      continue;
    }

    if (element.tagName === "fig" || element.tagName === "table-wrap") {
      const captionText = normalizeText(
        getFirstDirectChild(element, "caption")?.textContent ?? "",
      );
      appendBlock(
        blocks,
        captionText,
        sectionTitle,
        element.tagName === "fig" ? "figure_caption" : "table_caption",
        offsetState,
      );
    }
  }
}

function parseJatsBlocks(doc: Document): ParsedPaperBlock[] {
  const blocks: ParsedPaperBlock[] = [];
  const offsetState: OffsetState = { value: 0 };

  const abstracts = doc.getElementsByTagName("abstract");
  for (let i = 0; i < abstracts.length; i++) {
    const abstract = abstracts.item(i);
    if (!abstract) {
      continue;
    }
    appendBlock(
      blocks,
      abstract.textContent ?? "",
      "Abstract",
      "abstract",
      offsetState,
    );
  }

  const body = doc.getElementsByTagName("body").item(0);
  if (!body || body.nodeType !== 1) {
    return blocks;
  }

  for (let i = 0; i < body.childNodes.length; i++) {
    const node = body.childNodes.item(i);
    if (node?.nodeType !== 1) {
      continue;
    }
    const element = node as Element;
    if (element.tagName === "sec") {
      walkJatsSection(element, undefined, blocks, offsetState);
      continue;
    }
    if (element.tagName === "p") {
      appendBlock(
        blocks,
        element.textContent ?? "",
        undefined,
        "body_paragraph",
        offsetState,
      );
    }
  }

  return blocks;
}

function parseJatsDocument(fullText: string): ParsedPaperDocument {
  const doc = new DOMParser().parseFromString(fullText, "text/xml");
  const blocks = parseJatsBlocks(doc);
  return {
    parserKind: "jats",
    parserVersion: PARSED_PAPER_PARSER_VERSION,
    fullTextFormat: "jats_xml",
    blocks,
    references: parseJatsReferences(doc),
    mentions: parseJatsMentions(doc, blocks),
  };
}

function findTeiBiblId(element: Element): string | undefined {
  return (
    element.getAttribute("xml:id") ??
    element.getAttribute("id") ??
    element.getAttribute("n") ??
    undefined
  );
}

function parseGrobidReferences(doc: Document): ParsedPaperReference[] {
  const bibliography = getElementsByTagName(doc, "listBibl")[0];
  if (!bibliography) {
    return [];
  }

  const references: ParsedPaperReference[] = [];
  for (const bibl of getElementsByTagName(bibliography, "biblStruct")) {
    const refId = findTeiBiblId(bibl);
    if (!refId) {
      continue;
    }

    const doiEl = findFirstMatchingElement(
      bibl,
      "idno",
      (el) => (el.getAttribute("type") ?? "").toLowerCase() === "doi",
    );
    const pmcidEl = findFirstMatchingElement(
      bibl,
      "idno",
      (el) => (el.getAttribute("type") ?? "").toLowerCase() === "pmcid",
    );
    const pmidEl = findFirstMatchingElement(
      bibl,
      "idno",
      (el) => (el.getAttribute("type") ?? "").toLowerCase() === "pmid",
    );
    const titleEl =
      findFirstMatchingElement(
        bibl,
        "title",
        (el) => (el.getAttribute("level") ?? "").toLowerCase() === "a",
      ) ?? getFirstElement(bibl, "title");
    const dateEl = getFirstElement(bibl, "date");
    const surnames = getElementsByTagName(bibl, "surname").map(getTextContent);

    references.push({
      refId,
      doi: doiEl ? getTextContent(doiEl) : undefined,
      pmcid: pmcidEl ? getTextContent(pmcidEl) : undefined,
      pmid: pmidEl ? getTextContent(pmidEl) : undefined,
      year: parseYear(
        dateEl?.getAttribute("when") ?? getTextContent(dateEl ?? bibl),
      ),
      title: titleEl ? getTextContent(titleEl) : undefined,
      label: bibl.getAttribute("n") ?? undefined,
      authorSurnames: surnames,
    });
  }

  return references;
}

function getTeiSectionTitle(node: Node): string | undefined {
  let current = node.parentNode;
  while (current) {
    if (current.nodeType === 1) {
      const element = current as Element;
      if (element.tagName === "div") {
        const head = getFirstDirectChild(element, "head");
        if (head) {
          return getTextContent(head);
        }
      }
    }
    current = current.parentNode;
  }
  return undefined;
}

function isTeiBibrRef(el: Element): boolean {
  return (
    el.tagName === "ref" &&
    (el.getAttribute("type") ?? "").toLowerCase() === "bibr"
  );
}

function readTeiTargetRefIds(el: Element): string[] {
  return (el.getAttribute("target") ?? "")
    .split(/\s+/)
    .map((target) => target.replace(/^#/, ""))
    .filter(Boolean);
}

function parseGrobidMentions(
  doc: Document,
  blocks: readonly ParsedPaperBlock[],
): ParsedCitationMention[] {
  const body = getElementsByTagName(doc, "body")[0];
  if (!body) {
    return [];
  }

  const mentions: ParsedCitationMention[] = [];
  let mentionIndex = 0;
  const seenParagraphs = new Set<Element>();

  for (const ref of getElementsByTagName(body, "ref")) {
    if (!isTeiBibrRef(ref)) continue;
    const paragraph = findAncestor(ref, "p");
    if (!paragraph || seenParagraphs.has(paragraph)) continue;
    seenParagraphs.add(paragraph);

    const { rawContext, groups } = locateCitationGroupsInParagraph(
      paragraph,
      isTeiBibrRef,
      readTeiTargetRefIds,
    );
    const blockId = matchBlockIdForParagraph(blocks, rawContext);
    const block = blocks.find((entry) => entry.blockId === blockId);

    for (let groupOrdinal = 0; groupOrdinal < groups.length; groupOrdinal++) {
      const group = groups[groupOrdinal]!;
      const bundle = refineBundlePattern(
        rawContext,
        group,
        bundleMetadataForGroup(groups, groupOrdinal),
      );
      const absoluteStart =
        block && group.locationQuality === "exact_dom"
          ? block.charOffsetStart + group.localStart
          : undefined;
      const absoluteEnd =
        block && group.locationQuality === "exact_dom"
          ? block.charOffsetStart + group.localEnd
          : undefined;
      const sourceLocator = buildSourceLocator(blockId, groupOrdinal);
      mentions.push(
        buildParsedCitationMention({
          mentionIndex,
          rawContext,
          citationMarker: group.citationMarker,
          sectionTitle: getTeiSectionTitle(group.element),
          targetRefIds: group.targetRefIds,
          charOffsetStart: absoluteStart,
          charOffsetEnd: absoluteEnd,
          locationQuality:
            absoluteStart != null && absoluteEnd != null
              ? "exact_dom"
              : sourceLocator
                ? "approximate"
                : "missing",
          sourceLocator,
          blockId,
          citationGroupOrdinal: groupOrdinal,
          bundle,
          sourceType: "grobid_tei",
          parser: "grobid-tei",
        }),
      );
      mentionIndex++;
    }
  }

  return mentions;
}

function parseTeiAbstractBlocks(
  doc: Document,
  blocks: ParsedPaperBlock[],
  offsetState: OffsetState,
): void {
  for (const abstract of getElementsByTagName(doc, "abstract")) {
    for (const paragraph of getElementsByTagName(abstract, "p")) {
      appendBlock(
        blocks,
        paragraph.textContent ?? "",
        "Abstract",
        "abstract",
        offsetState,
      );
    }
  }
}

function walkTeiNode(
  node: Element,
  inheritedTitle: string | undefined,
  blocks: ParsedPaperBlock[],
  offsetState: OffsetState,
): void {
  const sectionTitle =
    normalizeText(getFirstDirectChild(node, "head")?.textContent ?? "") ||
    inheritedTitle;

  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes.item(i);
    if (child?.nodeType !== 1) {
      continue;
    }

    const element = child as Element;
    if (element.tagName === "div") {
      walkTeiNode(element, sectionTitle, blocks, offsetState);
      continue;
    }

    if (element.tagName === "p") {
      appendBlock(
        blocks,
        element.textContent ?? "",
        sectionTitle,
        "body_paragraph",
        offsetState,
      );
      continue;
    }

    if (element.tagName === "figure") {
      const figureText = normalizeText(
        getTextContent(element).replace(/\s+/g, " ").trim(),
      );
      appendBlock(
        blocks,
        figureText,
        sectionTitle,
        (element.getAttribute("type") ?? "").toLowerCase() === "table"
          ? "table_caption"
          : "figure_caption",
        offsetState,
      );
    }
  }
}

function parseGrobidBlocks(doc: Document): ParsedPaperBlock[] {
  const blocks: ParsedPaperBlock[] = [];
  const offsetState: OffsetState = { value: 0 };
  parseTeiAbstractBlocks(doc, blocks, offsetState);

  const body = getElementsByTagName(doc, "body")[0];
  if (!body) {
    return blocks;
  }

  for (let i = 0; i < body.childNodes.length; i++) {
    const child = body.childNodes.item(i);
    if (child?.nodeType !== 1) {
      continue;
    }
    const element = child as Element;
    if (element.tagName === "div") {
      walkTeiNode(element, undefined, blocks, offsetState);
      continue;
    }
    if (element.tagName === "p") {
      appendBlock(
        blocks,
        element.textContent ?? "",
        undefined,
        "body_paragraph",
        offsetState,
      );
    }
  }

  return blocks;
}

function parseGrobidDocument(fullText: string): ParsedPaperDocument {
  const doc = new DOMParser().parseFromString(fullText, "text/xml");
  const blocks = parseGrobidBlocks(doc);
  return {
    parserKind: "grobid_tei",
    parserVersion: PARSED_PAPER_PARSER_VERSION,
    fullTextFormat: "grobid_tei_xml",
    blocks,
    references: parseGrobidReferences(doc),
    mentions: parseGrobidMentions(doc, blocks),
  };
}

export function parseParsedPaperDocument(
  fullText: string,
  format: FullTextFormat,
): Result<ParsedPaperDocument> {
  try {
    switch (format) {
      case "jats_xml":
        return { ok: true, data: parseJatsDocument(fullText) };
      case "grobid_tei_xml":
        return { ok: true, data: parseGrobidDocument(fullText) };
      default: {
        const _exhaustive: never = format;
        return {
          ok: false,
          error: `Unsupported full-text format: ${String(_exhaustive)}`,
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseSectionsJson(blocks: ParsedPaperBlock[]): string | undefined {
  const sections = [
    ...new Set(blocks.map((block) => block.sectionTitle).filter(Boolean)),
  ];
  return sections.length > 0 ? JSON.stringify(sections) : undefined;
}

function decodeCachedParsedPaper(
  cached: ReturnType<typeof getParsedPaper>,
  fullTextFormat: FullTextFormat,
): Result<ParsedPaperDocument> {
  if (!cached) {
    return { ok: false, error: "No parsed cache entry" };
  }

  try {
    const parsed = parsedPaperDocumentSchema.parse({
      parserKind: cached.parserKind,
      parserVersion: cached.parserVersion,
      fullTextFormat,
      blocks: JSON.parse(cached.chunksJson ?? "[]") as unknown,
      references: JSON.parse(cached.refsJson ?? "[]") as unknown,
      mentions: JSON.parse(cached.mentionsJson ?? "[]") as unknown,
    });
    return { ok: true, data: parsed };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function materializeParsedPaper(
  paper: ResolvedPaper,
  biorxivBaseUrl: string,
  adapters: FullTextFetchAdapters,
  cache?: ParsedPaperCacheOptions,
): Promise<ParsedPaperMaterializeResult> {
  const fullTextResult = await acquireFullText(
    paper,
    biorxivBaseUrl,
    adapters,
    cache,
  );
  if (!fullTextResult.ok) {
    return {
      ok: false,
      error: fullTextResult.error,
      failureCode: fullTextResult.failureCode,
      acquisition: fullTextResult.acquisition,
    };
  }

  const contentHash = computeContentHash(fullTextResult.data.content);
  if (cache && cache.cachePolicy !== "force_refresh") {
    const cached = getParsedPaper(
      cache.db,
      paper.id,
      PARSED_PAPER_PARSER_VERSION,
      contentHash,
    );
    const decoded = decodeCachedParsedPaper(cached, fullTextResult.data.format);
    if (decoded.ok) {
      const acquisition = {
        ...fullTextResult.data.acquisition,
        materializationSource: "parsed_cache" as const,
      };
      return {
        ok: true,
        data: {
          fullText: fullTextResult.data,
          acquisition,
          parsedDocument: decoded.data,
        },
      };
    }
  }

  const parsedResult = parseParsedPaperDocument(
    fullTextResult.data.content,
    fullTextResult.data.format,
  );
  if (!parsedResult.ok) {
    return {
      ok: false,
      error: parsedResult.error,
      failureCode: "invalid_content",
      acquisition: fullTextResult.data.acquisition,
    };
  }

  if (cache) {
    try {
      upsertParsedData(cache.db, {
        paperId: paper.id,
        parserVersion: PARSED_PAPER_PARSER_VERSION,
        parserKind: parsedResult.data.parserKind,
        contentHash,
        sectionsJson: parseSectionsJson(parsedResult.data.blocks),
        refsJson: JSON.stringify(parsedResult.data.references),
        chunksJson: JSON.stringify(parsedResult.data.blocks),
        mentionsJson: JSON.stringify(parsedResult.data.mentions),
        parsedAt: new Date().toISOString(),
      });
    } catch {
      // parsed cache write failure is non-fatal
    }
  }

  return {
    ok: true,
    data: {
      fullText: fullTextResult.data,
      acquisition: fullTextResult.data.acquisition,
      parsedDocument: parsedResult.data,
    },
  };
}

/**
 * Materialize a parsed paper from a local PDF file via GROBID.
 * Used when the seed paper is behind a paywall but the user has a local copy.
 */
export async function materializeLocalPdf(
  pdfPath: string,
  adapters: FullTextFetchAdapters,
): Promise<ParsedPaperMaterializeResult> {
  const pdfBuffer = readFileSync(pdfPath);
  const grobidResult = await adapters.processPdfWithGrobid(pdfBuffer);
  if (!grobidResult.ok) {
    return {
      ok: false,
      error: grobidResult.error,
      failureCode: classifyAcquisitionAttemptFailure({
        failureReason: grobidResult.error,
      }),
      acquisition: undefined,
    };
  }

  const teiXml = grobidResult.data;
  const parsedResult = parseParsedPaperDocument(teiXml, "grobid_tei_xml");
  if (!parsedResult.ok) {
    return {
      ok: false,
      error: parsedResult.error,
      failureCode: "invalid_content",
      acquisition: undefined,
    };
  }

  const acquisition: FullTextAcquisition = {
    materializationSource: "network",
    selectedMethod: "direct_pdf_grobid",
    selectedUrl: `file://${pdfPath}`,
    selectedLocatorKind: "direct_pdf_url",
    attempts: [],
    accessChannel: "local_pdf",
  };

  return {
    ok: true,
    data: {
      fullText: {
        content: teiXml,
        format: "grobid_tei_xml",
      },
      acquisition,
      parsedDocument: parsedResult.data,
    },
  };
}

type BibliographyMatchMethod =
  | "doi"
  | "author_year_exact_title"
  | "author_year_title_overlap";

export type BibliographyMatch = {
  reference: ParsedPaperReference;
  method: BibliographyMatchMethod;
};

const TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "of",
  "the",
  "in",
  "on",
  "for",
  "to",
  "with",
]);

function normalizeBibliographyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(title: string): Set<string> {
  return new Set(
    normalizeBibliographyTitle(title)
      .split(" ")
      .filter((token) => token.length > 1 && !TITLE_STOPWORDS.has(token)),
  );
}

function titleTokenOverlapRatio(
  seedTitle: string,
  referenceTitle: string,
): number {
  const seedTokens = titleTokens(seedTitle);
  const referenceTokens = titleTokens(referenceTitle);
  if (seedTokens.size === 0 || referenceTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of seedTokens) {
    if (referenceTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / seedTokens.size;
}

function normalizeSurname(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}]/gu, "");
}

const AUTHOR_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

/**
 * Conservatively infer a surname from a provider display name.
 *
 * OpenAlex commonly returns "Given Family"; some providers return
 * "Family, Given". Suffixes are ignored. Compound surnames remain a possible
 * false-negative, which is safer than matching the wrong bibliography entry.
 */
export function inferFirstAuthorSurname(
  displayName: string | undefined,
): string | undefined {
  const trimmed = displayName?.trim();
  if (!trimmed) return undefined;

  const commaSurname = trimmed.split(",", 1)[0]?.trim();
  if (trimmed.includes(",") && commaSurname) {
    return commaSurname;
  }

  const parts = trimmed.split(/\s+/);
  while (
    parts.length > 1 &&
    AUTHOR_SUFFIXES.has(normalizeSurname(parts.at(-1)!))
  ) {
    parts.pop();
  }
  return parts.at(-1);
}

/**
 * Match a seed paper against a citing bibliography.
 *
 * Order: DOI → exact normalized title → conservative author+year+title-token
 * overlap. Ambiguous conservative matches are rejected.
 */
export function matchReferenceByMetadata(
  references: ParsedPaperReference[],
  locator: {
    doi?: string;
    title: string;
    publicationYear?: number;
    firstAuthorSurname?: string;
  },
): BibliographyMatch | undefined {
  if (locator.doi) {
    const normalizedDoi = locator.doi
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .toLowerCase();
    const byDoi = references.find(
      (reference) =>
        reference.doi
          ?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
          .toLowerCase() === normalizedDoi,
    );
    if (byDoi) {
      return { reference: byDoi, method: "doi" };
    }
  }

  const normalizedTitle = normalizeBibliographyTitle(locator.title);
  const year = locator.publicationYear;
  const firstAuthor = locator.firstAuthorSurname
    ? normalizeSurname(locator.firstAuthorSurname)
    : undefined;
  if (year == null || !firstAuthor || normalizedTitle.length === 0) {
    return undefined;
  }

  const conservativeMatches = references.filter((reference) => {
    if (reference.year !== year) return false;
    const refFirst = reference.authorSurnames[0];
    if (!refFirst || normalizeSurname(refFirst) !== firstAuthor) return false;
    if (!reference.title) return false;
    return titleTokenOverlapRatio(locator.title, reference.title) >= 0.8;
  });
  if (conservativeMatches.length !== 1) {
    return undefined;
  }
  const reference = conservativeMatches[0]!;
  return {
    reference,
    method:
      normalizeBibliographyTitle(reference.title!) === normalizedTitle
        ? "author_year_exact_title"
        : "author_year_title_overlap",
  };
}

/** @deprecated Prefer matchReferenceByMetadata for match-method provenance. */
export function findReferenceByMetadata(
  references: ParsedPaperReference[],
  locator: {
    doi?: string;
    title: string;
    publicationYear?: number;
    firstAuthorSurname?: string;
  },
): ParsedPaperReference | undefined {
  return matchReferenceByMetadata(references, locator)?.reference;
}
