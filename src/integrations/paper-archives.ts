import { z } from "zod";
import type { Result } from "../domain/common.js";
import { fetchJson } from "./http-client.js";

const biorxivDetailSchema = z.object({
  collection: z.array(z.object({ jatsxml: z.string().min(1) }).passthrough()),
});

export async function findBiorxivXmlUrl(
  apiUrl: string,
): Promise<Result<string | undefined>> {
  const response = await fetchJson(apiUrl, biorxivDetailSchema);
  return response.ok
    ? { ok: true, data: response.data.collection[0]?.jatsxml }
    : response;
}

const pmcIdConverterSchema = z.object({
  records: z.array(
    z
      .object({
        pmcid: z.string().optional(),
        errmsg: z.string().optional(),
        status: z.string().optional(),
      })
      .passthrough(),
  ),
});

export async function resolvePmcidFromDoi(
  doi: string,
  email: string | undefined,
): Promise<Result<string>> {
  const toolParam = "palimpsest";
  const emailParam = email ? `&email=${encodeURIComponent(email)}` : "";
  const idUrl = `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${encodeURIComponent(doi)}&format=json&tool=${toolParam}${emailParam}`;
  const idResult = await fetchJson(idUrl, pmcIdConverterSchema);
  if (!idResult.ok) {
    return idResult;
  }
  const record = idResult.data.records[0];
  const pmcid = record?.pmcid;
  if (!pmcid) {
    return {
      ok: false,
      error: record?.errmsg ?? "No PMCID found for DOI",
    };
  }
  return { ok: true, data: pmcid };
}
