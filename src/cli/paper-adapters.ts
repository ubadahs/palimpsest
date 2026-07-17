/**
 * Shared full-text adapter construction for the canonical pipeline.
 */

import {
  createDefaultAdapters,
  type FullTextFetchAdapters,
} from "../retrieval/fulltext-fetch.js";
import type { AppConfig } from "../config/app-config.js";

export type CitingYearRange = { fromYear?: number; toYear?: number };

/**
 * Create full-text fetch adapters directly from AppConfig.
 * Eliminates repeated field extraction across CLI commands.
 */
export function createFullTextAdapters(
  config: AppConfig,
): FullTextFetchAdapters {
  return createDefaultAdapters({
    grobidBaseUrl: config.providerBaseUrls.grobid,
    email: config.openAlexEmail,
    institutionalProxyUrl: config.institutionalProxyUrl,
  });
}
