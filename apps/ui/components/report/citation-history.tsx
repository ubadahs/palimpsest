import { useEffect, useState } from "react";
import {
  comparePaperPublicationDates,
  statementCreditLabel,
  statementRelationshipLabel,
  titleWithPublicationYear,
} from "palimpsest/contract";
import type {
  CitationHistoryArtifact,
  CitationHistoryPath,
  HistoryCitationUse,
  HistoryDirectCitation,
  HistoryPaper,
} from "palimpsest/history";

import {
  FindingEvidence,
  MarkedCitationContext,
} from "@/components/report/citation-statements";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CitationHistorySummary } from "@/lib/citation-history";
import { humanizeCode, shortId } from "@/lib/report-format";
import { DoiLink } from "@/lib/rich-text";
import { fetchJson } from "@/lib/utils";

const directCitationLabels: Record<HistoryDirectCitation["status"], string> = {
  same_group: "Original cited in the same reference group",
  elsewhere: "Original cited elsewhere in the paper",
  bibliography_only: "Original found only in the bibliography",
  no_match_in_parsed_references:
    "No match for the original in the parsed references",
  unknown: "Direct citation status unknown",
};

type HistoryResponse<T> = { data: T } | { error: string } | undefined;

function useHistoryResponse<T>(
  url: string,
  refresh: number,
): HistoryResponse<T> {
  const [response, setResponse] = useState<{
    url: string;
    refresh: number;
    result: HistoryResponse<T>;
  }>();
  useEffect(() => {
    const request = new AbortController();
    void fetchJson<T>(url, { signal: request.signal, cache: "no-store" }).then(
      (data) => {
        if (!request.signal.aborted)
          setResponse({ url, refresh, result: { data } });
      },
      (error: unknown) => {
        if (request.signal.aborted) return;
        setResponse({
          url,
          refresh,
          result: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
    return () => request.abort();
  }, [url, refresh]);
  return response?.url === url && response.refresh === refresh
    ? response.result
    : undefined;
}

function HistoryPaperName({ paper }: { paper: HistoryPaper }) {
  const title = titleWithPublicationYear(paper.title, paper.publicationYear);
  return paper.doi ? <DoiLink doi={paper.doi}>{title}</DoiLink> : title;
}

function HistoryRelation({
  relationship,
  reason,
  retained,
  changes,
}: {
  relationship: string;
  reason: string;
  retained: string[];
  changes: string[];
}) {
  return (
    <div className="space-y-2 text-sm">
      <Badge variant="neutral">
        {statementRelationshipLabel(relationship)}
      </Badge>
      <p>{reason}</p>
      {retained.length > 0 && (
        <p>
          <span className="font-semibold">Retained</span> ·{" "}
          {retained.join(" / ")}
        </p>
      )}
      {changes.length > 0 && (
        <p>
          <span className="font-semibold">Changed</span> · {changes.join(" / ")}
        </p>
      )}
    </div>
  );
}

const routeLabels = {
  direct_restatement: "Direct restatement",
  uptake: "Original finding used in the intermediate paper’s contribution",
  independent_contribution: "Intermediate paper’s own finding",
  unresolved: "Unresolved",
  unrelated: "Unrelated",
};

function RouteEvidence({
  label,
  evidence,
}: {
  label: string;
  evidence: { blockId: string; text: string; start: number; end: number }[];
}) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">{label}</summary>
      <ul className="mt-2 space-y-2">
        {evidence.map((quote) => (
          <li
            key={`${quote.blockId}-${String(quote.start)}-${String(quote.end)}`}
          >
            <blockquote>“{quote.text}”</blockquote>
            <p className="break-all text-xs text-[var(--text-muted)]">
              Block <code>{quote.blockId}</code> · offsets {quote.start}–
              {quote.end}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ProvenanceDetails({
  artifacts,
}: {
  artifacts: HistoryCitationUse["provenanceArtifacts"];
}) {
  if (artifacts.length === 0) return null;
  return (
    <details className="text-xs text-[var(--text-muted)]">
      <summary className="cursor-pointer font-medium">
        Source and execution records
      </summary>
      <ul className="mt-2 space-y-1">
        {artifacts.map((artifact) => (
          <li className="break-all" key={artifact.artifactId}>
            {humanizeCode(artifact.role)} · <code>{artifact.artifactId}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

function HistoryCitationUseEvidence({ use }: { use: HistoryCitationUse }) {
  return (
    <details
      id={use.useId}
      className="space-y-2 rounded-2xl border border-[var(--border)] bg-white/70 px-5 py-4 text-sm"
    >
      <summary className="cursor-pointer font-semibold">
        {titleWithPublicationYear(use.citing.title, use.citing.publicationYear)}{" "}
        · {use.citationMarker}
      </summary>
      {use.citing.doi && (
        <p>
          <DoiLink doi={use.citing.doi}>{use.citing.doi}</DoiLink>
        </p>
      )}
      {use.statementText && <p>{use.statementText}</p>}
      <MarkedCitationContext
        context={use.context}
        {...(use.markerSpan ? { markerSpan: use.markerSpan } : {})}
      />
      {use.supportSpan && <p>Exact support · “{use.supportSpan.text}”</p>}
      {use.bibliographyMatch && (
        <p>
          Matched bibliography entry <code>{use.bibliographyMatch.refId}</code>
          {" · "}
          {humanizeCode(use.bibliographyMatch.method)}
        </p>
      )}
      {use.credit && (
        <Badge
          variant={
            use.credit === "shared_reference_group" ? "warning" : "neutral"
          }
        >
          {statementCreditLabel(use.credit)}
        </Badge>
      )}
      <ProvenanceDetails artifacts={use.provenanceArtifacts} />
    </details>
  );
}

function HistoryPath({
  path,
  uses,
}: {
  path: CitationHistoryPath;
  uses: ReadonlyMap<string, HistoryCitationUse>;
}) {
  return (
    <details className="rounded-3xl border border-[var(--border)] bg-white/70">
      <summary className="cursor-pointer px-5 py-4 text-sm font-semibold">
        {titleWithPublicationYear(
          path.original.title,
          path.original.publicationYear,
        )}{" "}
        →{" "}
        {titleWithPublicationYear(
          path.middle.title,
          path.middle.publicationYear,
        )}
        <span className="ml-2 font-normal text-[var(--text-muted)]">
          · {String(path.laterHops.length)} later citation records
        </span>
      </summary>
      <div className="space-y-5 border-t border-[var(--border)] px-5 py-4">
        <section className="space-y-3">
          <h4 className="text-sm font-semibold">
            Statement citing <HistoryPaperName paper={path.original} />
          </h4>
          <p className="text-sm text-[var(--text-muted)]">
            In <HistoryPaperName paper={path.middle} />
          </p>
          {!path.firstHop.supportSpan && path.firstHop.text && (
            <p className="text-sm">{path.firstHop.text}</p>
          )}
          <MarkedCitationContext
            context={path.firstHop.context}
            {...(path.firstHop.markerSpan
              ? { markerSpan: path.firstHop.markerSpan }
              : {})}
          />
          {path.firstHop.supportSpan && (
            <p className="text-sm">
              Exact support · “{path.firstHop.supportSpan.text}”
            </p>
          )}
          <Badge
            variant={
              path.firstHop.credit === "shared_reference_group"
                ? "warning"
                : "neutral"
            }
          >
            {statementCreditLabel(path.firstHop.credit)}
          </Badge>
          <HistoryRelation {...path.firstHop} />
          <ProvenanceDetails artifacts={path.firstHop.provenanceArtifacts} />
          {path.firstHop.findings.map((finding, index) => (
            <div
              className="space-y-1"
              id={`${path.statementId}-${finding.findingId}`}
              key={finding.findingId}
            >
              <p className="text-xs font-semibold">
                Original finding {index + 1}
              </p>
              <FindingEvidence finding={finding} />
            </div>
          ))}
          <p className="text-xs text-[var(--text-muted)]">
            Statement ID <code className="break-all">{path.statementId}</code>
          </p>
        </section>
        {path.laterHops.length === 0 && (
          <p className="text-sm text-[var(--text-muted)]">
            No later citation records were saved. Coverage by paper is listed
            below.
          </p>
        )}
        {path.laterHops.map((hop) => {
          const use = uses.get(hop.useId);
          if (!use) return null;
          return (
            <section
              className="space-y-3 border-t border-[var(--border)] pt-4"
              key={hop.useId}
            >
              <h4 className="text-sm font-semibold">
                <a
                  className="text-[var(--accent)] hover:underline"
                  href={`#${use.useId}`}
                  onClick={() => {
                    const evidence = document.getElementById(use.useId);
                    if (evidence instanceof HTMLDetailsElement)
                      evidence.open = true;
                  }}
                >
                  {titleWithPublicationYear(
                    use.citing.title,
                    use.citing.publicationYear,
                  )}
                </a>
              </h4>
              <p className="text-sm font-medium">
                {directCitationLabels[hop.directCitation.status]}
              </p>
              {hop.status !== "assessed" && (
                <Badge variant="warning">{humanizeCode(hop.status)}</Badge>
              )}
              <p className="text-sm">{hop.reason}</p>
              {hop.assessments.map((assessment) => {
                const findingNumber =
                  path.firstHop.findings.findIndex(
                    (finding) => finding.findingId === assessment.findingId,
                  ) + 1;
                return (
                  <div
                    className="space-y-2 rounded-lg border border-[var(--border)] p-3"
                    key={assessment.caseId}
                  >
                    <h5 className="text-sm font-semibold">
                      <a
                        className="text-[var(--accent)] hover:underline"
                        href={`#${path.statementId}-${assessment.findingId}`}
                      >
                        Original finding {findingNumber}
                      </a>
                    </h5>
                    {assessment.status === "assessed" ? (
                      <>
                        <p className="text-sm">
                          <span className="font-semibold">
                            Use of the intermediate paper
                          </span>{" "}
                          · {routeLabels[assessment.route.kind]}
                        </p>
                        <p className="text-sm">{assessment.reason}</p>
                        <h6 className="text-sm font-semibold">
                          Fidelity to the intermediate paper
                        </h6>
                        <p className="text-sm">
                          {assessment.immediateFidelity.status ===
                          "assessed" ? (
                            <span className="font-semibold">
                              {assessment.immediateFidelity.verdict} ·{" "}
                            </span>
                          ) : (
                            <span className="font-semibold">Unassessed · </span>
                          )}
                          {assessment.immediateFidelity.reason}
                        </p>
                        {assessment.immediateFidelity.status === "assessed" && (
                          <RouteEvidence
                            label="Evidence for fidelity"
                            evidence={assessment.immediateFidelity.evidence}
                          />
                        )}
                        {assessment.parentEvidenceStatus === "unavailable" && (
                          <p className="text-sm">
                            The exact intermediate text was unavailable for this
                            assessment.
                          </p>
                        )}
                        {assessment.parentEvidenceStatus === "oversized" && (
                          <p className="text-sm">
                            The intermediate text exceeded the assessment length
                            limit.
                          </p>
                        )}
                        <h6 className="text-sm font-semibold">
                          Comparison with the original finding
                        </h6>
                        <HistoryRelation
                          {...assessment.comparison}
                          relationship={assessment.comparison.status}
                        />
                        {"connection" in assessment.route && (
                          <RouteEvidence
                            label="Connection in the intermediate paper"
                            evidence={assessment.route.connection}
                          />
                        )}
                        {"contribution" in assessment.route && (
                          <RouteEvidence
                            label="Contribution of the intermediate paper"
                            evidence={assessment.route.contribution}
                          />
                        )}
                        {assessment.parentTextVersionId && (
                          <p className="break-all text-xs text-[var(--text-muted)]">
                            Intermediate source{" "}
                            <code>{assessment.parentTextVersionId}</code>
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm">
                        {humanizeCode(assessment.status)} · {assessment.reason}
                      </p>
                    )}
                    <ProvenanceDetails
                      artifacts={assessment.provenanceArtifacts ?? []}
                    />
                  </div>
                );
              })}
              <ProvenanceDetails
                artifacts={hop.directCitation.provenanceArtifacts}
              />
            </section>
          );
        })}
      </div>
    </details>
  );
}

function HistoryArtifact({ url, refresh }: { url: string; refresh: number }) {
  const response = useHistoryResponse<CitationHistoryArtifact>(url, refresh);
  if (!response)
    return (
      <p className="text-sm" role="status">
        Loading citation history…
      </p>
    );
  if ("error" in response)
    return (
      <p className="text-sm" role="alert">
        {response.error}
      </p>
    );

  const { limits, selection, paths, neighborhoods, citationUses } =
    response.data.payload;
  const uses = new Map(citationUses.map((use) => [use.useId, use]));
  return (
    <div className="space-y-4">
      <div className="space-y-2 text-sm text-[var(--text-muted)]">
        <p>
          {String(selection.selectedCount)} of {String(selection.eligibleCount)}{" "}
          eligible statements selected.
        </p>
        <p>
          Search limits · {String(limits.maxHops)} hops,{" "}
          {String(limits.maxParents)} statements, {String(limits.maxCiters)}{" "}
          citing papers. Cumulative history budget · $
          {String(limits.maxCostUsd)}.
        </p>
        <a
          className="font-medium text-[var(--accent)] hover:underline"
          href={`${url}&download=1`}
        >
          Download history JSON
        </a>
      </div>
      {paths
        .toSorted((left, right) =>
          comparePaperPublicationDates(left.middle, right.middle),
        )
        .map((path) => (
          <HistoryPath key={path.statementId} path={path} uses={uses} />
        ))}
      {citationUses.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">
            Downstream citation evidence
          </h3>
          {citationUses
            .toSorted((left, right) =>
              comparePaperPublicationDates(left.citing, right.citing),
            )
            .map((use) => (
              <HistoryCitationUseEvidence key={use.useId} use={use} />
            ))}
        </section>
      )}
      {neighborhoods.length > 0 && (
        <h3 className="text-sm font-semibold">Citing-paper coverage</h3>
      )}
      {neighborhoods
        .toSorted((left, right) =>
          comparePaperPublicationDates(left.middle, right.middle),
        )
        .map((item) => (
          <details
            className="rounded-3xl border border-[var(--border)] bg-white/70 px-5 py-4 text-sm"
            key={item.middle.paperId}
          >
            <summary className="cursor-pointer font-semibold">
              {titleWithPublicationYear(
                item.middle.title,
                item.middle.publicationYear,
              )}{" "}
              · {humanizeCode(item.status)} · coverage {item.coverage}
            </summary>
            <div className="mt-3 space-y-2">
              <p>{item.reason}</p>
              {item.middleSource && (
                <p>
                  Intermediate source · {humanizeCode(item.middleSource.status)}{" "}
                  · {item.middleSource.reason}
                </p>
              )}
              <p>
                {String(item.citers.length)} listed
                {item.providerReportedTotal != null &&
                  ` of ${String(item.providerReportedTotal)} reported`}{" "}
                · {String(item.omittedCount)} omitted ·{" "}
                {String(item.allocatedCiterLimit)} slots allocated
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {item.citers
                  .toSorted((left, right) =>
                    comparePaperPublicationDates(left.paper, right.paper),
                  )
                  .map((entry) => (
                    <li key={entry.paper.paperId}>
                      <HistoryPaperName paper={entry.paper} /> ·{" "}
                      {humanizeCode(entry.status)} · {entry.reason}
                    </li>
                  ))}
              </ul>
            </div>
          </details>
        ))}
    </div>
  );
}

export function CitationHistory({
  runId,
  reportArtifactId,
}: {
  runId: string;
  reportArtifactId: string;
}) {
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const url = `/api/runs/${encodeURIComponent(runId)}/history?report=${encodeURIComponent(reportArtifactId)}`;
  const response = useHistoryResponse<CitationHistorySummary[]>(url, refresh);
  const histories = response && "data" in response ? response.data : [];
  const activeId =
    histories.find((history) => history.artifactId === selectedId)
      ?.artifactId ?? histories[0]?.artifactId;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {histories.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            Saved history
            <select
              className="rounded-lg border border-[var(--border)] p-2"
              onChange={(event) => setSelectedId(event.target.value)}
              value={activeId}
            >
              {histories.map((item) => (
                <option key={item.artifactId} value={item.artifactId}>
                  {shortId(item.artifactId)} · {String(item.pathCount)} paths ·{" "}
                  {String(item.neighborhoodCount)} citing neighborhoods
                </option>
              ))}
            </select>
          </label>
        )}
        <Button
          onClick={() => setRefresh((value) => value + 1)}
          variant="secondary"
        >
          Refresh
        </Button>
      </div>
      {!response ? (
        <p className="text-sm" role="status">
          Loading saved histories…
        </p>
      ) : "error" in response ? (
        <p className="text-sm" role="alert">
          {response.error}
        </p>
      ) : activeId ? (
        <HistoryArtifact
          refresh={refresh}
          url={`${url}&artifact=${encodeURIComponent(activeId)}`}
        />
      ) : (
        <p className="text-sm text-[var(--text-muted)]">
          No citation history has been saved for this report.
        </p>
      )}
    </div>
  );
}
