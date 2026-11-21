import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

import type { Result } from "../domain/common.js";

const run = promisify(execFile);

type SearchablePdf = { pdf: Buffer; nativeText: string };

/** Rebuild the text layer when GROBID cannot use the original PDF. */
export async function rebuildPdfTextLayer(
  pdf: Buffer,
): Promise<Result<SearchablePdf>> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "palimpsest-ocr-"));
    const input = join(directory, "input.pdf");
    await writeFile(input, pdf);
    const { stdout: nativeText } = await run(
      "pdftotext",
      ["-raw", input, "-"],
      {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ).catch(() => ({ stdout: "" }));

    await run(
      "pdftoppm",
      ["-r", "250", "-gray", "-png", input, join(directory, "page")],
      {
        timeout: 60_000,
      },
    );
    const pages = (await readdir(directory))
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort();
    if (!pages.length) return { ok: false, error: "No PDF pages rendered" };

    const pageList = join(directory, "pages.txt");
    await writeFile(pageList, `${pages.join("\n")}\n`);
    const output = join(directory, "searchable");
    await run("tesseract", [pageList, output, "pdf"], {
      cwd: directory,
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
      timeout: 120_000,
    });
    return {
      ok: true,
      data: { pdf: await readFile(`${output}.pdf`), nativeText },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

type TextToken = { text: string; offset: number };

function tokenizeWithOffsets(text: string): TextToken[] {
  return Array.from(text.matchAll(/\S+/gu), (match) => ({
    text: match[0],
    offset: match.index,
  }));
}

function surroundingWordKey(
  tokens: readonly TextToken[],
  index: number,
): string | undefined {
  if (index < 2 || index + 2 >= tokens.length) return undefined;
  const keys = [index - 2, index - 1, index + 1, index + 2].map((i) =>
    tokens[i]!.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""),
  );
  return keys.every(Boolean) ? keys.join(" ") : undefined;
}

/** Restore OCR tokens with a damaged suffix from the PDF's embedded text.
 * Require a unique surrounding phrase and an exact numeric prefix. Preserve
 * legible quantities, citation markers, and the document structure. */
export function restoreOcrNumbers(
  tei: string,
  nativeText: string,
): { tei: string; replacements: number } {
  if (!nativeText.trim()) return { tei, replacements: 0 };
  const native = tokenizeWithOffsets(
    nativeText.replace(/(\p{L})-\r?\n(?=\p{Ll})/gu, "$1"),
  );
  const nativeNumbersByContext = new Map<string, string | null>();
  native.forEach(({ text }, index) => {
    if (!/^\d{3,}$/u.test(text)) return;
    const key = surroundingWordKey(native, index);
    if (key) {
      nativeNumbersByContext.set(
        key,
        nativeNumbersByContext.has(key) ? null : text,
      );
    }
  });
  if (!nativeNumbersByContext.size) return { tei, replacements: 0 };

  const doc = new DOMParser().parseFromString(tei, "text/xml");
  const body = doc.getElementsByTagName("body").item(0);
  let replacements = 0;
  for (const paragraph of Array.from(body?.getElementsByTagName("p") ?? [])) {
    const tokens = tokenizeWithOffsets(paragraph.textContent ?? "");
    const corrections = tokens
      .flatMap((token, index) => {
        const prefix = /^(\d{2,})[!%*?'’~]+$/u.exec(token.text)?.[1];
        if (!prefix) return [];
        const key = surroundingWordKey(tokens, index);
        const original = key ? nativeNumbersByContext.get(key) : undefined;
        return original?.startsWith(prefix) && original.length > prefix.length
          ? [{ ...token, original }]
          : [];
      })
      .reverse();
    if (!corrections.length) continue;

    let offset = 0;
    const visit = (node: Node, inReference: boolean): void => {
      if (
        node.nodeType !== node.TEXT_NODE &&
        node.nodeType !== node.CDATA_SECTION_NODE
      ) {
        for (const child of Array.from(node.childNodes)) {
          visit(
            child,
            inReference ||
              (node.nodeType === node.ELEMENT_NODE &&
                (node as Element).localName === "ref"),
          );
        }
        return;
      }
      const value = node.nodeValue ?? "";
      const start = offset;
      offset += value.length;
      if (inReference || node.nodeType !== node.TEXT_NODE) return;
      let rewritten = value;
      for (const correction of corrections) {
        if (
          correction.offset < start ||
          correction.offset + correction.text.length > offset
        )
          continue;
        const local = correction.offset - start;
        rewritten =
          rewritten.slice(0, local) +
          correction.original +
          rewritten.slice(local + correction.text.length);
        replacements++;
      }
      if (rewritten !== value) {
        node.parentNode?.replaceChild(doc.createTextNode(rewritten), node);
      }
    };
    visit(paragraph, false);
  }
  return {
    tei: replacements ? new XMLSerializer().serializeToString(doc) : tei,
    replacements,
  };
}
