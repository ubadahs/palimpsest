import { createHash } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";

import type { Result } from "../domain/common.js";
import { tracedFetch } from "../telemetry/http.js";
import {
  currentTraceSession,
  rethrowTraceError,
  traceCheckpoint,
  traceOperation,
} from "../telemetry/trace.js";
import { rebuildPdfTextLayer, restoreOcrNumbers } from "./pdf-ocr.js";

const GROBID_REQUEST_TIMEOUT_MS = 30_000;

type TeiInspection = {
  status: "tei";
  bodyParagraphs: number;
  bibliographyEntries: number;
  resolvedBodyMarkers: number;
};

type GrobidInspection =
  | TeiInspection
  | { status: "invalid_tei" }
  | { status: "http_error"; httpStatus: number }
  | { status: "request_error" };

type GrobidAttempt = { result: Result<string>; inspection: GrobidInspection };

function inspectTei(tei: string): TeiInspection | { status: "invalid_tei" } {
  if (!tei.trim()) return { status: "invalid_tei" };
  try {
    const document = new DOMParser().parseFromString(tei, "text/xml");
    if (document.documentElement?.localName !== "TEI")
      return { status: "invalid_tei" };
    const body = document.getElementsByTagName("body").item(0);
    const paragraphs = Array.from(body?.getElementsByTagName("p") ?? []).filter(
      (paragraph) => paragraph.textContent?.trim(),
    );
    const bibliography = document.getElementsByTagName("listBibl").item(0);
    const entries = Array.from(
      bibliography?.getElementsByTagName("biblStruct") ?? [],
    );
    const ids = new Set(
      entries
        .map(
          (entry) =>
            entry.getAttribute("xml:id") ??
            entry.getAttribute("id") ??
            entry.getAttribute("n"),
        )
        .filter(Boolean),
    );
    const resolvedBodyMarkers = Array.from(
      body?.getElementsByTagName("ref") ?? [],
    ).filter(
      (ref) =>
        ref.getAttribute("type")?.toLowerCase() === "bibr" &&
        ref.textContent?.trim() &&
        ref
          .getAttribute("target")
          ?.split(/\s+/)
          .some((target) => ids.has(target.replace(/^#/, ""))),
    ).length;
    return {
      status: "tei",
      bodyParagraphs: paragraphs.length,
      bibliographyEntries: entries.length,
      resolvedBodyMarkers,
    };
  } catch {
    return { status: "invalid_tei" };
  }
}

function repairTrigger(inspection: GrobidInspection) {
  switch (inspection.status) {
    case "invalid_tei":
      return "invalid_tei";
    case "tei":
      return inspection.bodyParagraphs === 0 ? "empty_body" : undefined;
    case "http_error":
      return inspection.httpStatus === 500 ? "http_500" : undefined;
    case "request_error":
      return undefined;
  }
}

async function submitPdfToGrobid(
  buffer: Buffer,
  grobidBaseUrl: string,
): Promise<GrobidAttempt> {
  try {
    const formData = new FormData();
    const pdfBytes = Uint8Array.from(buffer).buffer;
    formData.append(
      "input",
      new Blob([pdfBytes], { type: "application/pdf" }),
      "paper.pdf",
    );
    formData.append("consolidateHeader", "0");
    formData.append("consolidateCitations", "0");

    const normalizedBaseUrl = grobidBaseUrl.replace(/\/+$/, "");
    const resp = await tracedFetch(
      `${normalizedBaseUrl}/api/processFulltextDocument`,
      {
        method: "POST",
        headers: {
          "User-Agent": "palimpsest/0.1",
        },
        body: formData,
        signal: AbortSignal.timeout(GROBID_REQUEST_TIMEOUT_MS),
      },
    );

    if (!resp.ok) {
      return {
        result: {
          ok: false,
          error: `GROBID HTTP ${String(resp.status)} from ${normalizedBaseUrl}`,
        },
        inspection: { status: "http_error", httpStatus: resp.status },
      };
    }

    const tei = await resp.text();
    const inspection = inspectTei(tei);
    return {
      result:
        inspection.status === "invalid_tei"
          ? { ok: false, error: "Invalid TEI response from GROBID" }
          : { ok: true, data: tei },
      inspection,
    };
  } catch (err) {
    rethrowTraceError(err);
    return {
      result: {
        ok: false,
        error: `GROBID parse error: ${err instanceof Error ? err.message : String(err)}`,
      },
      inspection: { status: "request_error" },
    };
  }
}

export async function parsePdfWithGrobid(
  buffer: Buffer,
  grobidBaseUrl: string,
): Promise<Result<string>> {
  const originalSha256 = createHash("sha256").update(buffer).digest("hex");
  const first = await submitPdfToGrobid(buffer, grobidBaseUrl);
  const trigger = repairTrigger(first.inspection);
  function recordSelection(
    selected: "initial" | "ocr",
    result: Result<string>,
    repaired?: GrobidInspection,
  ): Result<string> {
    traceCheckpoint("grobid_parse", {
      originalSha256,
      initial: first.inspection,
      ...(trigger ? { ocrTrigger: trigger } : {}),
      ...(repaired ? { repaired } : {}),
      selected,
      ok: result.ok,
    });
    return result;
  }
  if (!trigger) return recordSelection("initial", first.result);

  return traceOperation(
    "tool",
    "pdf_ocr",
    { originalSha256, trigger, engine: "tesseract" },
    async () => {
      const searchable = await rebuildPdfTextLayer(buffer);
      if (!searchable.ok) {
        traceCheckpoint("ocr_unavailable", { reason: searchable.error });
        return recordSelection("initial", first.result);
      }
      traceCheckpoint("searchable_pdf", {
        payload: currentTraceSession().bytes(searchable.data.pdf),
      });
      const retry = await submitPdfToGrobid(searchable.data.pdf, grobidBaseUrl);
      if (!retry.result.ok || repairTrigger(retry.inspection)) {
        // A valid first response can carry an abstract even if it has no body.
        return first.result.ok
          ? recordSelection("initial", first.result, retry.inspection)
          : recordSelection("ocr", retry.result, retry.inspection);
      }
      const { tei, replacements } = restoreOcrNumbers(
        retry.result.data,
        searchable.data.nativeText,
      );
      if (replacements) {
        traceCheckpoint("native_pdf_numbers", {
          nativeText: currentTraceSession().bytes(
            Buffer.from(searchable.data.nativeText),
          ),
          replacements,
        });
      }
      return recordSelection("ocr", { ok: true, data: tei }, retry.inspection);
    },
  );
}
