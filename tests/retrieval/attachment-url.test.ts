import { describe, expect, it } from "vitest";
import {
  cachedAttachmentUrls,
  isAttachmentUrl,
} from "../../src/retrieval/attachment-url.js";

describe("attachment URL evidence", () => {
  it.each([
    "https://publisher.org/esm/article/MediaObjects/paper_MOESM2_ESM.pdf",
    "https://publisher.org/suppl_file/report.pdf",
    "https://publisher.org/peer-review.pdf",
    "https://proxy.org/login?url=https%3A%2F%2Fpublisher.org%2Fsupplement%2Ffile.pdf",
    "https://publisher.org/supplementary-material.pdf?download=1",
  ])("rejects %s", (url) => expect(isAttachmentUrl(url)).toBe(true));
  it("does not guess from ordinary filenames or malformed escapes", () => {
    expect(isAttachmentUrl("https://publisher.org/article.pdf")).toBe(false);
    expect(isAttachmentUrl("https://publisher.org/article%zz.pdf")).toBe(false);
  });
  it("ignores failed attachments when an article was ultimately selected", () => {
    expect(
      cachedAttachmentUrls(
        JSON.stringify({
          selectedUrl: "https://publisher.org/article.pdf",
          attempts: [
            { url: "https://publisher.org/peer-review.pdf", success: false },
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      cachedAttachmentUrls(
        JSON.stringify({
          attempts: [
            { url: "https://publisher.org/peer-review.pdf", success: true },
          ],
        }),
      ),
    ).toEqual(["https://publisher.org/peer-review.pdf"]);
    expect(cachedAttachmentUrls("invalid")).toEqual([]);
  });
});
