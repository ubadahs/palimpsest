import { DOMImplementation, XMLSerializer } from "@xmldom/xmldom";

import { Window } from "happy-dom";
import type { Element as HtmlElement } from "happy-dom";

import type { Result } from "../domain/common.js";

export const PMC_HTML_PROJECTION_VERSION = "pmc-html-v1";

function hasClass(element: HtmlElement, className: string): boolean {
  return (element.getAttribute("class") ?? "").split(/\s+/).includes(className);
}

function append(parent: Element, name: string, text?: string): Element {
  const doc = parent.ownerDocument;
  const element = doc.createElement(name);
  if (text) element.appendChild(doc.createTextNode(text));
  parent.appendChild(element);
  return element;
}

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const omittedInline = new Set(["script", "style", "button", "noscript"]);
const omittedSections = ["abstract", "ref-list", "fn-group", "kwd-group"];
const bodyWrappers = new Set([
  "div",
  "aside",
  "ul",
  "ol",
  "li",
  "table",
  "figcaption",
]);

function projectInline(
  parent: Element,
  source: HtmlElement,
  refs: ReadonlySet<string>,
): void {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 3) {
      parent.appendChild(
        parent.ownerDocument.createTextNode(child.nodeValue ?? ""),
      );
      continue;
    }
    if (child.nodeType !== 1) continue;
    const element = child as HtmlElement;
    if (omittedInline.has(element.localName)) continue;
    const href =
      element.localName === "a" ? element.getAttribute("href") : null;
    const target = href?.startsWith("#")
      ? decodeFragment(href.slice(1))
      : undefined;
    if (target && refs.has(target)) {
      const xref = append(parent, "xref");
      xref.setAttribute("ref-type", "bibr");
      xref.setAttribute("rid", target);
      projectInline(xref, element, refs);
    } else {
      projectInline(parent, element, refs);
    }
  }
}

function projectBody(
  parent: Element,
  source: HtmlElement,
  refs: ReadonlySet<string>,
): void {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType !== 1) continue;
    const element = child as HtmlElement;
    const { localName: tagName } = element;
    if (tagName === "section") {
      if (omittedSections.some((className) => hasClass(element, className)))
        continue;
      projectBody(append(parent, "sec"), element, refs);
    } else if (/^h[2-6]$/.test(tagName)) {
      projectInline(append(parent, "title"), element, refs);
    } else if (tagName === "p") {
      projectInline(append(parent, "p"), element, refs);
    } else if (tagName === "figure") {
      const caption = element.getElementsByTagName("figcaption").item(0);
      if (caption)
        projectBody(append(append(parent, "fig"), "caption"), caption, refs);
    } else if (bodyWrappers.has(tagName)) {
      projectBody(parent, element, refs);
    }
  }
}

function projectReference(
  list: Element,
  item: HtmlElement,
  refId: string,
): void {
  const reference = append(list, "ref");
  reference.setAttribute("id", refId);
  const citation = append(
    reference,
    "mixed-citation",
    item.getElementsByTagName("cite").item(0)?.textContent ?? undefined,
  );
  const links = Array.from(item.getElementsByTagName("a")).map(
    (link) => link.getAttribute("href") ?? "",
  );
  const doi = links.find((url) => /^https?:\/\/(?:dx\.)?doi\.org\//i.test(url));
  if (doi) {
    append(
      citation,
      "pub-id",
      decodeFragment(doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")),
    ).setAttribute("pub-id-type", "doi");
  }
  const pmcid = links
    .map((url) => url.match(/^\/articles\/(PMC\d+)\/?$/i)?.[1])
    .find(Boolean);
  if (pmcid)
    append(citation, "pub-id", pmcid).setAttribute("pub-id-type", "pmcid");
  const scholar = links.find((url) =>
    /^https?:\/\/scholar\.google\.com\/scholar_lookup\?/i.test(url),
  );
  if (scholar) {
    const metadata = new URLSearchParams(
      scholar.slice(scholar.indexOf("?") + 1),
    );
    const title = metadata.get("title");
    const year = metadata.get("publication_year");
    if (title) append(citation, "article-title", title);
    if (year) append(citation, "year", year);
  }
}

/** Project the official article view, preserving body order and exact marker text. */
export function projectPmcArticleHtml(
  html: string,
  expectedDoi: string,
): Result<string> {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
    },
  });
  try {
    const document = new window.DOMParser().parseFromString(html, "text/html");
    return projectDocument(document, expectedDoi);
  } finally {
    window.close();
  }
}

function projectDocument(
  document: Window["document"],
  expectedDoi: string,
): Result<string> {
  const doi = Array.from(document.getElementsByTagName("meta"))
    .find((element) => element.getAttribute("name") === "citation_doi")
    ?.getAttribute("content");
  if (doi?.trim().toLowerCase() !== expectedDoi.toLowerCase()) {
    return {
      ok: false,
      error: "PMC HTML article DOI did not match the resolved DOI",
    };
  }

  const sections = Array.from(document.getElementsByTagName("section"));
  const bodies = sections.filter((section) =>
    hasClass(section, "main-article-body"),
  );
  const body = bodies.length === 1 ? bodies[0] : undefined;
  if (!body)
    return { ok: false, error: "PMC HTML article body missing or ambiguous" };

  const references = new Map<string, HtmlElement>();
  for (const section of Array.from(body.getElementsByTagName("section"))) {
    if (!hasClass(section, "ref-list")) continue;
    for (const item of Array.from(section.getElementsByTagName("li"))) {
      const refId = item.getAttribute("id");
      if (!refId) continue;
      if (/\s/.test(refId) || references.has(refId)) {
        return {
          ok: false,
          error: "PMC HTML article bibliography IDs are ambiguous",
        };
      }
      references.set(refId, item);
    }
  }
  if (!references.size)
    return { ok: false, error: "PMC HTML article bibliography missing" };

  const refs = new Set(references.keys());
  const article = new DOMImplementation().createDocument(
    null,
    "article",
    null,
  ).documentElement;
  const abstract = Array.from(body.getElementsByTagName("section")).find(
    (section) => hasClass(section, "abstract"),
  );
  if (abstract) {
    const section = append(
      append(append(article, "front"), "article-meta"),
      "abstract",
    );
    for (const paragraph of Array.from(abstract.getElementsByTagName("p"))) {
      projectInline(append(section, "p"), paragraph, refs);
    }
  }
  projectBody(append(article, "body"), body, refs);
  const list = append(append(article, "back"), "ref-list");
  for (const [refId, item] of references) projectReference(list, item, refId);
  return { ok: true, data: new XMLSerializer().serializeToString(article) };
}
