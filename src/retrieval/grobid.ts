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

function inspectTeiBody(tei: string): "invalid" | "empty" | "present" {
  if (!tei.trim()) return "invalid";
  try {
    const document = new DOMParser().parseFromString(tei, "text/xml");
    if (document.documentElement?.localName !== "TEI") return "invalid";
    const body = document.getElementsByTagName("body").item(0);
    return Array.from(body?.getElementsByTagName("p") ?? []).some((paragraph) =>
      paragraph.textContent?.trim(),
    )
      ? "present"
      : "empty";
  } catch {
    return "invalid";
  }
}

async function submitPdfToGrobid(
  buffer: Buffer,
  grobidBaseUrl: string,
): Promise<{ result: Result<string>; retryWithOcr: boolean }> {
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
        retryWithOcr: resp.status === 500,
      };
    }

    const tei = await resp.text();
    const body = inspectTeiBody(tei);
    return {
      result:
        body === "invalid"
          ? { ok: false, error: "Invalid TEI response from GROBID" }
          : { ok: true, data: tei },
      retryWithOcr: body !== "present",
    };
  } catch (err) {
    rethrowTraceError(err);
    return {
      result: {
        ok: false,
        error: `GROBID parse error: ${err instanceof Error ? err.message : String(err)}`,
      },
      retryWithOcr: false,
    };
  }
}

export async function parsePdfWithGrobid(
  buffer: Buffer,
  grobidBaseUrl: string,
): Promise<Result<string>> {
  const first = await submitPdfToGrobid(buffer, grobidBaseUrl);
  if (!first.retryWithOcr) return first.result;

  return traceOperation(
    "tool",
    "pdf_ocr",
    { originalSha256: createHash("sha256").update(buffer).digest("hex") },
    async () => {
      const searchable = await rebuildPdfTextLayer(buffer);
      if (!searchable.ok) {
        traceCheckpoint("ocr_unavailable", { reason: searchable.error });
        return first.result;
      }
      traceCheckpoint("searchable_pdf", {
        payload: currentTraceSession().bytes(searchable.data.pdf),
      });
      const retry = await submitPdfToGrobid(searchable.data.pdf, grobidBaseUrl);
      if (!retry.result.ok || retry.retryWithOcr) {
        // A valid first response can carry an abstract even if it has no body.
        return first.result.ok ? first.result : retry.result;
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
      return { ok: true, data: tei };
    },
  );
}
