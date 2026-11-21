import { z } from "zod";

import { sha256DigestSchema } from "../contract/artifacts/primitives.js";
import { parseParsedPaperDocument } from "../retrieval/parsed-paper.js";
import { sha256Text } from "../shared/stable-identity.js";

const parseMetadataSchema = z.object({
  citingPaperId: z.string().min(1),
  sourceTextHash: sha256DigestSchema,
  parserKind: z.string().min(1),
  parserVersion: z.string().min(1),
  sourceText: z.string().min(1),
  fullTextFormat: z.enum(["jats_xml", "grobid_tei_xml"]),
});

export function decodeCitingPaperParse(body: unknown) {
  const metadata = parseMetadataSchema.parse(body);
  const digest = sha256Text(metadata.sourceText);
  if (digest !== metadata.sourceTextHash) {
    throw new Error(
      "Downstream source bytes do not match their parse provenance",
    );
  }
  const parsed = parseParsedPaperDocument(
    metadata.sourceText,
    metadata.fullTextFormat,
  );
  if (
    !parsed.ok ||
    parsed.data.parserKind !== metadata.parserKind ||
    parsed.data.parserVersion !== metadata.parserVersion
  ) {
    throw new Error(
      "Downstream source cannot be reproduced by its recorded parser",
    );
  }
  return {
    paperId: metadata.citingPaperId,
    sourceTextHash: digest,
    document: parsed.data,
  };
}
