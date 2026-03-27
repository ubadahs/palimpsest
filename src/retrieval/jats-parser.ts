import { DOMParser } from "@xmldom/xmldom";

import type { CitationMention } from "../domain/types.js";

// --- Reference extracted from JATS <ref-list> ---

export type JatsReference = {
  refId: string;
  doi: string | undefined;
  title: string | undefined;
  label: string | undefined;
  authorSurnames: string[];
};

// --- DOM helpers ---

function getTextContent(node: Node): string {
  return (node.textContent ?? "").trim();
}

function getElementsByTagName(parent: Node, tag: string): Element[] {
  const results: Element[] = [];
  const children = (parent as Element).getElementsByTagName(tag);
  for (let i = 0; i < children.length; i++) {
    const el = children.item(i);
    if (el) results.push(el);
  }
  return results;
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

// --- Parse <ref-list> into structured references ---

export function parseReferences(xml: string): JatsReference[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const refs: JatsReference[] = [];

  for (const refEl of getElementsByTagName(doc, "ref")) {
    const refId = refEl.getAttribute("id") ?? "";

    const doiEl = getElementsByTagName(refEl, "pub-id").find(
      (el) => el.getAttribute("pub-id-type") === "doi",
    );
    const doi = doiEl ? getTextContent(doiEl) : undefined;

    const titleEl = getFirstElement(refEl, "article-title");
    const title = titleEl ? getTextContent(titleEl) : undefined;

    const labelEl = getFirstElement(refEl, "label");
    const label = labelEl ? getTextContent(labelEl) : undefined;

    const authorSurnames: string[] = [];
    for (const surnameEl of getElementsByTagName(refEl, "surname")) {
      authorSurnames.push(getTextContent(surnameEl));
    }

    refs.push({ refId, doi, title, label, authorSurnames });
  }

  return refs;
}

// --- Match seed paper to a reference by DOI or title ---

function normalizeDoi(doi: string): string {
  return doi.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase();
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function findSeedReference(
  refs: JatsReference[],
  seedDoi: string | undefined,
  seedTitle: string,
): JatsReference | undefined {
  if (seedDoi) {
    const normalSeedDoi = normalizeDoi(seedDoi);
    const byDoi = refs.find(
      (r) => r.doi != null && normalizeDoi(r.doi) === normalSeedDoi,
    );
    if (byDoi) return byDoi;
  }

  const normalSeedTitle = normalizeTitle(seedTitle);
  return refs.find(
    (r) => r.title != null && normalizeTitle(r.title) === normalSeedTitle,
  );
}

// --- Extract <xref ref-type="bibr"> mentions with enclosing paragraph ---

function extractParagraphText(pEl: Element): string {
  return getTextContent(pEl).replace(/\s+/g, " ").trim();
}

function getSectionTitle(node: Node): string | undefined {
  const sec = findAncestor(node, "sec");
  if (!sec) return undefined;
  const titleEl = getFirstElement(sec, "title");
  return titleEl ? getTextContent(titleEl) : undefined;
}

// --- Bundled citation detection helpers ---

import type { BundlePattern } from "../domain/types.js";

function detectBundleInParagraph(
  targetXref: Element,
  pEl: Element,
): {
  isBundled: boolean;
  bundleSize: number;
  bundleRefIds: string[];
  bundlePattern: BundlePattern;
} {
  const allXrefs = getElementsByTagName(pEl, "xref").filter(
    (el) => el.getAttribute("ref-type") === "bibr",
  );

  const targetText = getTextContent(targetXref);
  const pText = getTextContent(pEl);
  const targetPos = pText.indexOf(targetText);
  if (targetPos < 0) {
    return {
      isBundled: false,
      bundleSize: 1,
      bundleRefIds: [],
      bundlePattern: "single",
    };
  }

  const CLUSTER_RADIUS = 80;
  const clusterRefs: string[] = [];

  for (const xref of allXrefs) {
    const xText = getTextContent(xref);
    const xPos = pText.indexOf(xText);
    if (xPos >= 0 && Math.abs(xPos - targetPos) <= CLUSTER_RADIUS) {
      const rids = (xref.getAttribute("rid") ?? "").split(/\s+/);
      for (const rid of rids) {
        if (rid && !clusterRefs.includes(rid)) clusterRefs.push(rid);
      }
    }
  }

  if (clusterRefs.length <= 1) {
    return {
      isBundled: false,
      bundleSize: 1,
      bundleRefIds: [],
      bundlePattern: "single",
    };
  }

  const windowStart = Math.max(0, targetPos - CLUSTER_RADIUS);
  const windowEnd = Math.min(
    pText.length,
    targetPos + targetText.length + CLUSTER_RADIUS,
  );
  const window = pText.substring(windowStart, windowEnd);
  const hasSemicolons = window.includes(";");

  const bundlePattern: BundlePattern = hasSemicolons
    ? "semicolon_separated"
    : "parenthetical_group";

  return {
    isBundled: true,
    bundleSize: clusterRefs.length,
    bundleRefIds: clusterRefs,
    bundlePattern,
  };
}

export function extractCitationMentions(
  xml: string,
  targetRefIds: string[],
): CitationMention[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const targetSet = new Set(targetRefIds);
  const mentions: CitationMention[] = [];
  let mentionIndex = 0;

  const bodyEl = getFirstElement(doc, "body");
  if (!bodyEl) return mentions;

  for (const xref of getElementsByTagName(bodyEl, "xref")) {
    if (xref.getAttribute("ref-type") !== "bibr") continue;

    const rids = (xref.getAttribute("rid") ?? "").split(/\s+/);
    if (!rids.some((rid) => targetSet.has(rid))) continue;

    const pEl = findAncestor(xref, "p");
    if (!pEl) continue;

    const rawContext = extractParagraphText(pEl);
    const citationMarker = getTextContent(xref);
    const sectionTitle = getSectionTitle(xref);
    const markerStart = rawContext.indexOf(citationMarker);

    const bundle = detectBundleInParagraph(xref, pEl);

    mentions.push({
      mentionIndex,
      rawContext,
      citationMarker,
      sectionTitle,
      isDuplicate: false,
      contextLength: rawContext.length,
      markerStyle: "unknown",
      contextType: "unknown",
      confidence: "low",
      isBundledCitation: bundle.isBundled,
      bundleSize: bundle.bundleSize,
      bundleRefIds: bundle.bundleRefIds,
      bundlePattern: bundle.bundlePattern,
      provenance: {
        sourceType: "jats_xml",
        parser: "jats-xref",
        refId: rids.find((rid) => targetSet.has(rid)),
        charOffsetStart: markerStart >= 0 ? markerStart : undefined,
        charOffsetEnd:
          markerStart >= 0 ? markerStart + citationMarker.length : undefined,
      },
    });

    mentionIndex++;
  }

  return mentions;
}
