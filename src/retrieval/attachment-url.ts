import { z } from "zod";

/** Conservative URL evidence only; this is not a general document classifier. */
export function isAttachmentUrl(url: string): boolean {
  let decoded = url;
  try {
    // Also inspect encoded publisher URLs wrapped by an institutional proxy.
    decoded = decodeURIComponent(url);
  } catch {
    // A malformed escape must not abort acquisition or a cache audit.
  }
  return /(?:\/esm\/|\/supplements?\/|\/suppl(?:ementary)?(?:_file|\/)|_MOESM\d+_|(?:peer[-_ ]?review|supplementary)[^/?]*\.pdf)/i.test(
    decoded,
  );
}

const acquisitionUrlsSchema = z
  .object({
    selectedUrl: z.string().optional(),
    attempts: z
      .array(
        z
          .object({
            url: z.string().optional(),
            success: z.boolean(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** Failed attempts do not taint a subsequently successful article acquisition. */
export function cachedAttachmentUrls(
  provenanceJson: string | undefined,
): string[] {
  if (!provenanceJson) return [];
  try {
    const parsed = acquisitionUrlsSchema.safeParse(JSON.parse(provenanceJson));
    if (!parsed.success) return [];
    const urls = [
      parsed.data.selectedUrl,
      ...(parsed.data.attempts ?? [])
        .filter((attempt) => attempt.success)
        .map((attempt) => attempt.url),
    ];
    return [
      ...new Set(
        urls.filter(
          (url): url is string => url != null && isAttachmentUrl(url),
        ),
      ),
    ];
  } catch {
    return [];
  }
}
