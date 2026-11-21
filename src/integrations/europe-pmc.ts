import { z } from "zod";

import { normalizeDoi } from "../contract/artifacts/checks.js";
import type { Result } from "../domain/common.js";
import { fetchJson } from "./http-client.js";

const europePmcSearchSchema = z.object({
  resultList: z.object({
    result: z.array(
      z.object({
        id: z.string(),
        source: z.string(),
        doi: z.string().optional(),
        fullTextUrlList: z
          .object({
            fullTextUrl: z.array(
              z.object({
                availabilityCode: z.string().optional(),
                documentStyle: z.string().optional(),
                url: z.string(),
              }),
            ),
          })
          .optional(),
      }),
    ),
  }),
});

/** Look up free PDF links for the exact PubMed/DOI pair. Return the query
 * URL so acquisition can record the lookup alongside attempts to fetch text. */
export async function findEuropePmcFreePdfUrls(
  pmid: string,
  doi: string,
): Promise<{ searchUrl: string; result: Result<string[]> }> {
  const searchUrl = new URL(
    "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
  );
  searchUrl.search = new URLSearchParams({
    query: `EXT_ID:${pmid} AND SRC:MED`,
    resultType: "core",
    format: "json",
  }).toString();
  const response = await fetchJson(searchUrl.href, europePmcSearchSchema, {
    maxRetries: 1,
  });
  const normalizedDoi = normalizeDoi(doi);
  const work = response.ok
    ? response.data.resultList.result.find(
        (result) =>
          result.id === pmid &&
          result.source === "MED" &&
          result.doi &&
          normalizeDoi(result.doi) === normalizedDoi,
      )
    : undefined;
  const urls = work?.fullTextUrlList?.fullTextUrl.filter(
    ({ availabilityCode, documentStyle, url }) =>
      availabilityCode === "F" &&
      documentStyle === "pdf" &&
      /^https:\/\//i.test(url) &&
      z.url().safeParse(url).success,
  );
  return {
    searchUrl: searchUrl.href,
    result: response.ok
      ? { ok: true, data: urls?.map(({ url }) => url) ?? [] }
      : response,
  };
}
