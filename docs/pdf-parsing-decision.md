# Why Palimpsest uses GROBID for PDFs

**Decision (2026-11-21):** GROBID stays the default parser for PDF inputs, and Tesseract stays its repair for scans and unusable text layers. Structured article text (JATS) is used directly when acquisition selects it.

## What the parser has to deliver

Palimpsest needs each citing sentence, the exact position of its citation marker, and the bibliography entry that marker points to, plus the cited paper's section structure and quotable text. GROBID returns all of these in TEI, with citation markers already linked to bibliography entries. A transcription engine recovers the words on a page but still needs a separate step to attach each marker to the right reference, and that step is where most errors happen. [GROBID documentation](https://grobid.readthedocs.io/en/latest/Introduction/)

## Evidence

**Benchmark against PaddleOCR-VL.** Ten open-access papers from the annotated CEX Fulltext v3 corpus (five with numeric citations, five author–year, ten subject areas), plus four image-only copies of them. The protocol, cohort and scorer were fixed before any predictions were scored. A link counted when both the cited reference and the citing sentence matched the annotations. [CEX Fulltext v3](https://zenodo.org/records/16310561)

| Input | Parser | Links recovered | Micro F1 | Median time |
| --- | --- | ---: | ---: | ---: |
| 10 original PDFs | GROBID | 535/605 | 0.905 | 2.9 s |
| 10 original PDFs | PaddleOCR-VL with a separate citation linker | 402/605 | 0.762 | 66.8 s |
| 4 image-only copies | GROBID with Tesseract repair | 105/246 | 0.563 | 44.9 s |
| 4 image-only copies | PaddleOCR-VL with a separate citation linker | 191/246 | 0.804 | 69.1 s |

GROBID was better on nine of the ten originals, and its quotes and quantities were more often exact. PaddleOCR-VL was better on all four image-only copies.

**PaddleOCR-VL as a repair inside GROBID.** On two genuine image-only journal scans with numeric citations (32 hand-checked links), rebuilding the text layer with PaddleOCR-VL and parsing with GROBID recovered no field-verified links, against 5 with the Tesseract repair. It was also worse on exact quotes and quantities, and took about six times as long.

So for the PDFs tested, GROBID is the better default. PaddleOCR-VL reads scans better, but it hasn't yet been shown to help once GROBID does the linking.

## Limits

- The CEX annotations were produced with GROBID before manual correction, so they may favour GROBID-shaped output.
- The four image-only copies were rasterised from the originals, not real scans. Only two real scans were tested, both with numeric citations.
- Timings are from one workstation.

## What the adapter records

Each PDF parse writes a `grobid_parse` checkpoint to the run's trace. It holds the body-paragraph, bibliography-entry and resolved-marker counts of the first and any repaired attempt, what triggered the repair (HTTP 500, invalid TEI, or an empty body), and which attempt was used. A resolved marker is one whose target exists in the TEI bibliography. That makes it a structural signal, not proof that the target is the right paper. A parse with body text but no bibliography or no resolved markers does not trigger the repair, but it is visible in the trace. [GROBID adapter](../src/retrieval/grobid.ts) · [OCR repair](../src/retrieval/pdf-ocr.ts)

## When to revisit

Revisit with genuinely scanned and mixed-text documents, in both citation styles, whose citation targets are checked against the source. Compare any new repair against Tesseract through the same GROBID parse. Measure per-paper link precision and recall, exact quotes and quantities, and end-to-end time including failed attempts, and check that ordinary digital PDFs don't regress. Choose when to invoke a new repair from its own evaluated sample.
