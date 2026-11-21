import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { parsePdfWithGrobid } from "../../src/retrieval/grobid.js";
import * as pdfOcr from "../../src/retrieval/pdf-ocr.js";
import {
  createTraceSession,
  readTraceEvents,
  withTraceSession,
} from "../../src/telemetry/trace.js";

const traceRoots: string[] = [];

function traceRoot() {
  const root = mkdtempSync(join(tmpdir(), "palimpsest-grobid-test-"));
  traceRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of traceRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it.each([
  ["an HTTP 500", "", 500, "http_500"],
  ["an empty body", "<TEI><text><body/></text></TEI>", 200, "empty_body"],
  [
    "a non-TEI response",
    "<html><body><p>Parser unavailable</p></body></html>",
    200,
    "invalid_tei",
  ],
])(
  "rebuilds the PDF text layer after GROBID returns %s",
  async (_name, body, status, trigger) => {
    const root = traceRoot();
    const original = Buffer.from("%PDF-1.4 scan");
    const searchable = Buffer.from("%PDF-1.4 scan with OCR");
    const ocr = vi.spyOn(pdfOcr, "rebuildPdfTextLayer").mockResolvedValue({
      ok: true,
      data: { pdf: searchable, nativeText: "" },
    });
    const tei =
      "<TEI><text><body><div><p>Restored body.</p></div></body></text></TEI>";
    const submitted: Buffer[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (!(init.body instanceof FormData))
          throw new Error("Expected GROBID form data");
        const pdf = init.body.get("input");
        if (!(pdf instanceof Blob)) throw new Error("Expected PDF upload");
        const bytes = Buffer.from(await pdf.arrayBuffer());
        submitted.push(bytes);
        return bytes.equals(original)
          ? new Response(body, { status })
          : new Response(tei);
      }),
    );
    await expect(
      withTraceSession(createTraceSession(root), () =>
        parsePdfWithGrobid(original, "http://localhost:8070"),
      ),
    ).resolves.toEqual({
      ok: true,
      data: tei,
    });
    expect(ocr).toHaveBeenCalledExactlyOnceWith(original);
    expect(submitted).toEqual([original, searchable]);
    const parses = readTraceEvents(root).events.filter(
      (event) => event.name === "grobid_parse",
    );
    expect(parses).toHaveLength(1);
    expect(parses[0]?.data).toMatchObject({
      ocrTrigger: trigger,
      repaired: {
        status: "tei",
        bodyParagraphs: 1,
        bibliographyEntries: 0,
        resolvedBodyMarkers: 0,
      },
      selected: "ocr",
      ok: true,
    });
  },
);

it.each([
  ["#b1 #b2", 1],
  ["#missing", 0],
])(
  "journals scholarly structure for target %s without retrying a nonempty body",
  async (target, resolvedBodyMarkers) => {
    const root = traceRoot();
    const ocr = vi.spyOn(pdfOcr, "rebuildPdfTextLayer");
    const tei = `<TEI><text>
    <body><p>Words <ref type="bibr" target="${target}">[1, 2]</ref>.</p>
    <p><ref type="bibr" target="#unknown">[3]</ref><ref type="figure" target="#b1">Figure 1</ref>.</p><p> </p></body>
    <back><listBibl><biblStruct xml:id="b1"/><biblStruct xml:id="b2"/></listBibl></back>
    </text></TEI>`;
    const buffer = Buffer.from("%PDF");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(tei))),
    );

    await expect(
      withTraceSession(createTraceSession(root), () =>
        parsePdfWithGrobid(buffer, "http://localhost:8070"),
      ),
    ).resolves.toEqual({ ok: true, data: tei });
    expect(ocr).not.toHaveBeenCalled();
    expect(
      readTraceEvents(root).events.find(
        (event) => event.name === "grobid_parse",
      )?.data,
    ).toEqual({
      originalSha256: createHash("sha256").update(buffer).digest("hex"),
      initial: {
        status: "tei",
        bodyParagraphs: 2,
        bibliographyEntries: 2,
        resolvedBodyMarkers,
      },
      selected: "initial",
      ok: true,
    });
  },
);

it("restores a damaged OCR quantity when the original text uniquely agrees around it", () => {
  const input =
    "<TEI><body><p>We counted 110% cells per field. <ref target='#b2'>(2)</ref></p><p>Sample counts reached 120% cells per day.</p></body></TEI>";
  const nativeText =
    "We counted 1104 cells per field. (2) Sample counts reached 1201 cells per day. Sample counts reached 1203 cells per day.";
  const result = pdfOcr.restoreOcrNumbers(input, nativeText);
  expect(result).toMatchObject({ replacements: 1 });
  expect(result.tei).toContain(
    'We counted 1104 cells per field. <ref target="#b2">(2)</ref>',
  );
  expect(result.tei).toContain("Sample counts reached 120% cells per day.");
});

it("retains legible OCR measurements and never changes a conflicting numeric prefix", () => {
  const tei =
    "<TEI><body><p>The study counted 1234 records per week.</p><p>The stock reached 110% capacity per day.</p></body></TEI>";
  const nativeText =
    "The study counted 1294 records per week. The stock reached 1194 capacity per day.";
  expect(pdfOcr.restoreOcrNumbers(tei, nativeText)).toEqual({
    tei,
    replacements: 0,
  });
});

it("returns a parse failure when both responses are HTML", async () => {
  const pdf = Buffer.from("%PDF-1.4 scan");
  vi.spyOn(pdfOcr, "rebuildPdfTextLayer").mockResolvedValue({
    ok: true,
    data: { pdf, nativeText: "" },
  });
  const fetchStub = vi.fn(() =>
    Promise.resolve(
      new Response("<html><body><p>Unavailable</p></body></html>"),
    ),
  );
  vi.stubGlobal("fetch", fetchStub);
  await expect(
    parsePdfWithGrobid(pdf, "http://localhost:8070"),
  ).resolves.toEqual({
    ok: false,
    error: "Invalid TEI response from GROBID",
  });
  expect(fetchStub).toHaveBeenCalledTimes(2);
});
