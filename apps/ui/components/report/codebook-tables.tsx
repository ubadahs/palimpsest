import { Card, CardContent } from "@/components/ui/card";

import type { ReportPayload } from "./types";

type SeedCodebooks = ReportPayload["summary"]["seedCodebooks"];
type Counts = SeedCodebooks[number]["entries"][number]["counts"];

const COUNT_HEADERS = ["Claim units", "Adjudicated", "F", "D", "E", "U"];

function countCells(counts: Counts) {
  return [
    counts.taggedClaimUnits,
    counts.adjudicatedRecords,
    counts.F,
    counts.D,
    counts.E,
    counts.U,
  ].map((value, index) => (
    <td
      key={COUNT_HEADERS[index]}
      className="px-2 py-1 text-right tabular-nums"
    >
      {value}
    </td>
  ));
}

/**
 * The Report's codebook view: per seed, one table per level. Entries come
 * from the seed paper and stay fixed across runs of the same seed; tags say
 * what a claim is about and are not verdicts.
 */
export function CodebookTables({ codebooks }: { codebooks: SeedCodebooks }) {
  if (codebooks.length === 0) return null;
  return (
    <div className="space-y-4" data-testid="seed-codebook-tables">
      <div>
        <h3 className="text-sm font-semibold">Seed codebook view</h3>
        <p className="text-xs text-muted-foreground">
          Entries come from the seed paper and stay the same across runs of the
          same seed, so rows compare between runs. Tags say what a claim is
          about, not whether it is right; they are not verdicts. A theme counts
          a record once if it carries the theme or any entry under it.
        </p>
      </div>
      {codebooks.map((codebook) => (
        <Card key={codebook.seedId}>
          <CardContent className="space-y-3 pt-4 text-sm">
            <div>
              <div className="font-medium">
                {codebook.seedTitle ?? codebook.seedDoi}
              </div>
              <div className="text-xs text-muted-foreground">
                Codebook {codebook.codebookStatus}
                {codebook.unavailableReason
                  ? ` (${codebook.unavailableReason})`
                  : ""}
                {` · ${String(codebook.claims.total)} claims: ${String(codebook.claims.specific)} specific, ${String(codebook.claims.themeOnly)} theme only, ${String(codebook.claims.none)} none, ${String(codebook.claims.taggingFailed)} failed`}
                {codebook.uncitedEntryIds.length > 0
                  ? ` · uncited entries: ${codebook.uncitedEntryIds.join(", ")}`
                  : ""}
              </div>
            </div>
            {codebook.themes.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="px-2 py-1">Theme</th>
                      <th className="px-2 py-1">Statement</th>
                      <th className="px-2 py-1 text-right">Theme only</th>
                      <th className="px-2 py-1 text-right">Via entries</th>
                      {COUNT_HEADERS.map((header) => (
                        <th key={header} className="px-2 py-1 text-right">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {codebook.themes.map((theme) => (
                      <tr key={theme.themeId} className="border-t">
                        <td className="px-2 py-1 font-mono">
                          {theme.themeId}
                          {theme.isHeadline ? " (headline)" : ""}
                        </td>
                        <td className="px-2 py-1">{theme.statement}</td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {theme.themeOnlyClaimUnits}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {theme.entryClaimUnits}
                        </td>
                        {countCells(theme.counts)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {codebook.entries.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="px-2 py-1">Entry</th>
                      <th className="px-2 py-1">Theme</th>
                      <th className="px-2 py-1">Statement</th>
                      {COUNT_HEADERS.map((header) => (
                        <th key={header} className="px-2 py-1 text-right">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {codebook.entries.map((entry) => (
                      <tr key={entry.entryId} className="border-t">
                        <td className="px-2 py-1 font-mono">{entry.entryId}</td>
                        <td className="px-2 py-1 font-mono">{entry.themeId}</td>
                        <td className="px-2 py-1">
                          {entry.statement}
                          {entry.attributedToOtherWork ? " (relayed)" : ""}
                        </td>
                        {countCells(entry.counts)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
