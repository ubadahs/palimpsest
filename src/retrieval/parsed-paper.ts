import { readFileSync } from "node:fs";

import { DOMParser } from "@xmldom/xmldom";

import type Database from "better-sqlite3";

import type {
  CachePolicy,
  CitationMention,
  FullTextAcquisition,
  FullTextFormat,
  ParsedBlockKind,
  ParsedCitationMention,
  ParsedPaperBlock,
  ParsedPaperDocument,
  ParsedPaperReference,
  ResolvedPaper,
  Result,
} from "../domain/types.js";
import { parsedPaperDocumentSchema } from "../domain/types.js";
import {
  acquireFullText,
  type FullTextContent,
  type FullTextFetchAdapters,
} from "./fulltext-fetch.js";
import {
  computeContentHash,
  getParsedPaper,
  upsertParsedData,
} from "../storage/paper-cache.js";

export const PARSED_PAPER_PARSER_VERSION = "structured-v2";

export type ParsedPaperMaterialized = {
  fullText: FullTextContent;
  acquisition: FullTextAcquisition;
  parsedDocument: ParsedPaperDocument;
};

export type ParsedPaperMaterializeResult =
  | { ok: true; data: ParsedPaperMaterialized }
  | { ok: false; error: string; acquisition: FullTextAcquisition | undefined };

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

function detectBundle(
  targetText: string,
  allMarkers: Array<{ marker: string; refIds: string[] }>,
  rawContext: string,
): Pick<
  ParsedCitationMention,
  "isBundledCitation" | "bundleSize" | "bundleRefIds" | "bundlePattern"
> {
  const targetPos = rawContext.indexOf(targetText);
  if (targetPos < 0) {
    return {
      isBundledCitation: false,
      bundleSize: 1,
      bundleRefIds: [],
      bundlePattern: "single",
    };
  }

  const clusterRadius = 80;
  const bundleRefIds: string[] = [];
  for (const marker of allMarkers) {
    const markerPos = rawContext.indexOf(marker.marker);
    if (markerPos >= 0 && Math.abs(markerPos - targetPos) <= clusterRadius) {
      for (const refId of marker.refIds) {
        if (refId && !bundleRefIds.includes(refId)) {
          bundleRefIds.push(refId);
        }
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

  const windowStart = Math.max(0, targetPos - clusterRadius);
  const windowEnd = Math.min(
    rawContext.length,
    targetPos + targetText.length + clusterRadius,
  );
  const window = rawContext.substring(windowStart, windowEnd);

  return {
    isBundledCitation: true,
    bundleSize: bundleRefIds.length,
    bundleRefIds,
    bundlePattern: window.includes(";")
      ? "semicolon_separated"
      : "parenthetical_group",
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

function parseJatsMentions(doc: Document): ParsedCitationMention[] {
  const bodyEl = getFirstElement(doc, "body");
  if (!bodyEl) {
    return [];
  }

  const mentions: ParsedCitationMention[] = [];
  let mentionIndex = 0;
  for (const xref of getElementsByTagName(bodyEl, "xref")) {
    if (xref.getAttribute("ref-type") !== "bibr") {
      continue;
    }

    const paragraph = findAncestor(xref, "p");
    if (!paragraph) {
      continue;
    }

    const rawContext = getTextContent(paragraph);
    const citationMarker = getTextContent(xref);
    const targetRefIds = (xref.getAttribute("rid") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    const paragraphMarkers = getElementsByTagName(paragraph, "xref")
      .filter((el) => el.getAttribute("ref-type") === "bibr")
      .map((el) => ({
        marker: getTextContent(el),
        refIds: (el.getAttribute("rid") ?? "").split(/\s+/).filter(Boolean),
      }));
    const bundle = detectBundle(citationMarker, paragraphMarkers, rawContext);
    const markerStart = rawContext.indexOf(citationMarker);

    mentions.push({
      mentionIndex,
      rawContext,
      citationMarker,
      sectionTitle: getJatsSectionTitle(xref),
      refId: targetRefIds[0],
      charOffsetStart: markerStart >= 0 ? markerStart : undefined,
      charOffsetEnd:
        markerStart >= 0 ? markerStart + citationMarker.length : undefined,
      isBundledCitation: bundle.isBundledCitation,
      bundleSize: bundle.bundleSize,
      bundleRefIds: bundle.bundleRefIds,
      bundlePattern: bundle.bundlePattern,
      sourceType: "jats_xml",
      parser: "jats-normalized",
    });

    mentionIndex++;
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
  return {
    parserKind: "jats",
    parserVersion: PARSED_PAPER_PARSER_VERSION,
    fullTextFormat: "jats_xml",
    blocks: parseJatsBlocks(doc),
    references: parseJatsReferences(doc),
    mentions: parseJatsMentions(doc),
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

function parseGrobidMentions(doc: Document): ParsedCitationMention[] {
  const body = getElementsByTagName(doc, "body")[0];
  if (!body) {
    return [];
  }

  const mentions: ParsedCitationMention[] = [];
  let mentionIndex = 0;
  for (const ref of getElementsByTagName(body, "ref")) {
    if ((ref.getAttribute("type") ?? "").toLowerCase() !== "bibr") {
      continue;
    }

    const paragraph = findAncestor(ref, "p");
    if (!paragraph) {
      continue;
    }

    const rawContext = getTextContent(paragraph);
    const citationMarker = getTextContent(ref);
    const refIds = (ref.getAttribute("target") ?? "")
      .split(/\s+/)
      .map((target) => target.replace(/^#/, ""))
      .filter(Boolean);
    const paragraphMarkers = getElementsByTagName(paragraph, "ref")
      .filter((el) => (el.getAttribute("type") ?? "").toLowerCase() === "bibr")
      .map((el) => ({
        marker: getTextContent(el),
        refIds: (el.getAttribute("target") ?? "")
          .split(/\s+/)
          .map((target) => target.replace(/^#/, ""))
          .filter(Boolean),
      }));
    const bundle = detectBundle(citationMarker, paragraphMarkers, rawContext);
    const markerStart = rawContext.indexOf(citationMarker);

    mentions.push({
      mentionIndex,
      rawContext,
      citationMarker,
      sectionTitle: getTeiSectionTitle(ref),
      refId: refIds[0],
      charOffsetStart: markerStart >= 0 ? markerStart : undefined,
      charOffsetEnd:
        markerStart >= 0 ? markerStart + citationMarker.length : undefined,
      isBundledCitation: bundle.isBundledCitation,
      bundleSize: bundle.bundleSize,
      bundleRefIds: bundle.bundleRefIds,
      bundlePattern: bundle.bundlePattern,
      sourceType: "grobid_tei",
      parser: "grobid-tei",
    });
    mentionIndex++;
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
  return {
    parserKind: "grobid_tei",
    parserVersion: PARSED_PAPER_PARSER_VERSION,
    fullTextFormat: "grobid_tei_xml",
    blocks: parseGrobidBlocks(doc),
    references: parseGrobidReferences(doc),
    mentions: parseGrobidMentions(doc),
  };
}

function parseLegacyPdfDocument(fullText: string): ParsedPaperDocument {
  const blocks: ParsedPaperBlock[] = [];
  const paragraphs = fullText
    .split(/\n{2,}/)
    .map(normalizeText)
    .filter((paragraph) => paragraph.length >= 30);
  const offsetState: OffsetState = { value: 0 };

  for (const paragraph of paragraphs) {
    appendBlock(blocks, paragraph, undefined, "body_paragraph", offsetState);
  }

  return {
    parserKind: "legacy_pdf_text",
    parserVersion: PARSED_PAPER_PARSER_VERSION,
    fullTextFormat: "pdf_text",
    blocks,
    references: [],
    mentions: [],
  };
}

export function parseParsedPaperDocument(
  fullText: string,
  format: FullTextFormat,
): Result<ParsedPaperDocument> {
  try {
    const parsed =
      format === "jats_xml"
        ? parseJatsDocument(fullText)
        : format === "grobid_tei_xml"
          ? parseGrobidDocument(fullText)
          : parseLegacyPdfDocument(fullText);
    return { ok: true, data: parsed };
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
    return { ok: false, error: grobidResult.error, acquisition: undefined };
  }

  const teiXml = grobidResult.data;
  const parsedResult = parseParsedPaperDocument(teiXml, "grobid_tei_xml");
  if (!parsedResult.ok) {
    return { ok: false, error: parsedResult.error, acquisition: undefined };
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

export function findReferenceByMetadata(
  references: ParsedPaperReference[],
  locator: {
    doi?: string;
    title: string;
  },
): ParsedPaperReference | undefined {
  if (locator.doi) {
    const normalizedDoi = locator.doi
      .replace(/^https?:\/\/doi\.org\//i, "")
      .toLowerCase();
    const byDoi = references.find(
      (reference) =>
        reference.doi?.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase() ===
        normalizedDoi,
    );
    if (byDoi) {
      return byDoi;
    }
  }

  const normalizedTitle = locator.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  return references.find((reference) => {
    const referenceTitle = reference.title
      ?.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    return referenceTitle === normalizedTitle;
  });
}

export function toCitationMention(
  mention: ParsedCitationMention,
): CitationMention {
  return {
    mentionIndex: mention.mentionIndex,
    rawContext: mention.rawContext,
    citationMarker: mention.citationMarker,
    sectionTitle: mention.sectionTitle,
    isDuplicate: false,
    contextLength: mention.rawContext.length,
    markerStyle: "unknown",
    contextType: "unknown",
    confidence: "low",
    isBundledCitation: mention.isBundledCitation,
    bundleSize: mention.bundleSize,
    bundleRefIds: mention.bundleRefIds,
    bundlePattern: mention.bundlePattern,
    provenance: {
      sourceType: mention.sourceType,
      parser: mention.parser,
      refId: mention.refId,
      charOffsetStart: mention.charOffsetStart,
      charOffsetEnd: mention.charOffsetEnd,
    },
  };
}
