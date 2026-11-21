import { useMemo, useState } from "react";
import {
  compareSeedInventoryDates,
  compareStatementDates,
  splitCitationMarker,
  statementCreditLabel,
  statementFidelityLabel,
  statementRelationshipLabel,
  titleWithPublicationYear,
  type ReportInspectorSummary,
  type ReportStatementFidelity,
} from "palimpsest/contract";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { humanizeCode } from "@/lib/report-format";
import { DoiLink } from "@/lib/rich-text";

type StatementReview = ReportInspectorSummary["statementReview"];
type Statement = StatementReview["citationStatements"][number];
type Inventory = StatementReview["seedInventories"][number];
type Finding = Inventory["findings"][number];

const PAGE_SIZE = 25;

export function MarkedCitationContext({
  context,
  markerSpan,
}: {
  context: string;
  markerSpan?: { charOffsetStart: number; charOffsetEnd: number };
}) {
  const pieces = splitCitationMarker(context, markerSpan);
  return (
    <blockquote className="whitespace-pre-wrap rounded-2xl border border-[var(--border)] bg-[var(--panel-muted)] px-4 py-3 text-sm leading-7">
      {pieces ? (
        <>
          {pieces.before}
          <mark className="rounded bg-yellow-200 px-0.5 font-semibold">
            {pieces.marker}
          </mark>
          {pieces.after}
        </>
      ) : (
        context
      )}
    </blockquote>
  );
}

export function FindingEvidence({
  finding,
}: {
  finding: Pick<Finding, "statement" | "evidenceSpans">;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{finding.statement}</p>
      {finding.evidenceSpans.map((span) => (
        <blockquote
          className="border-l-2 border-[var(--border-strong)] pl-3 text-sm leading-6 text-[var(--text-muted)]"
          key={`${span.blockId}-${String(span.charOffsetStart)}-${String(span.charOffsetEnd)}`}
        >
          “{span.text}”
          {span.sectionTitle && (
            <span className="ml-2 text-xs">{span.sectionTitle}</span>
          )}
        </blockquote>
      ))}
    </div>
  );
}

function CitationStatement({
  statement,
  outcomes,
  findingsById,
  inventory,
}: {
  statement: Statement;
  outcomes: ReportStatementFidelity[];
  findingsById: ReadonlyMap<string, Finding>;
  inventory?: Inventory;
}) {
  const { assessment } = statement;
  return (
    <details className="rounded-3xl border border-[var(--border)] bg-white/70">
      <summary className="cursor-pointer space-y-2 px-5 py-4">
        <span className="ml-2 text-sm font-semibold">
          {statement.extractedClaimText}
        </span>
        <p className="text-sm text-[var(--text-muted)]">
          {titleWithPublicationYear(
            statement.citingTitle,
            statement.citingPublicationYear,
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Badge variant="neutral">
            {statementRelationshipLabel(assessment.relationship)}
          </Badge>
          <Badge
            variant={
              statement.credit === "shared_reference_group"
                ? "warning"
                : "neutral"
            }
          >
            {statementCreditLabel(statement.credit)}
          </Badge>
        </div>
      </summary>
      <div className="space-y-4 border-t border-[var(--border)] px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          {statement.citingDoi && <DoiLink doi={statement.citingDoi} />}
          {statement.sectionTitle && <span>{statement.sectionTitle}</span>}
          {statement.bundleRefIds.length > 1 && (
            <span>
              {String(statement.bundleRefIds.length)} references in this
              citation group
            </span>
          )}
        </div>
        {inventory && (
          <p className="text-sm">
            Cited paper ·{" "}
            <DoiLink doi={inventory.seedDoi}>
              {titleWithPublicationYear(
                inventory.seedTitle,
                inventory.seedPublicationYear,
              )}
            </DoiLink>
          </p>
        )}
        <MarkedCitationContext
          context={statement.citationContext}
          {...(statement.markerSpan
            ? { markerSpan: statement.markerSpan }
            : {})}
        />
        <section className="space-y-1 text-sm">
          <h4 className="font-semibold">Exact citing support</h4>
          {statement.textSpan ? (
            <blockquote className="text-[var(--text-muted)]">
              “{statement.textSpan.text}”
            </blockquote>
          ) : (
            <p className="text-[var(--text-muted)]">
              No exact support span was verified.
            </p>
          )}
        </section>
        <section className="space-y-2 text-sm">
          <h4 className="font-semibold">
            {statementRelationshipLabel(assessment.relationship)}
          </h4>
          <p>{assessment.reason}</p>
          {assessment.findingIds.map((id) => {
            const finding = findingsById.get(id);
            return finding && <FindingEvidence finding={finding} key={id} />;
          })}
          {assessment.retained.length > 0 && (
            <div>
              <p className="font-medium">Retained</p>
              <ul className="list-disc pl-5">
                {assessment.retained.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </div>
          )}
          {assessment.changes.length > 0 && (
            <div>
              <p className="font-medium">Changed</p>
              <ul className="list-disc pl-5">
                {assessment.changes.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
        <section className="space-y-1 border-t border-[var(--border)] pt-3 text-sm">
          <h4 className="font-semibold">Current fidelity</h4>
          {outcomes.length === 0 ? (
            <p>Unexamined</p>
          ) : (
            <ul className="list-disc pl-5">
              {outcomes.map((outcome) => (
                <li key={outcome.recordId}>
                  {statementFidelityLabel(outcome)}
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="text-xs text-[var(--text-muted)]">
          <span className="font-medium">Statement ID</span>{" "}
          <code className="break-all">{statement.statementId}</code>
        </div>
      </div>
    </details>
  );
}

export function CitationStatements({
  review,
  fidelity,
}: {
  review: StatementReview;
  fidelity: ReportInspectorSummary["statementFidelity"];
}) {
  const [page, setPage] = useState(0);
  const { seedInventories, citationStatements } = review;
  const orderedStatements = useMemo(
    () => citationStatements.toSorted(compareStatementDates),
    [citationStatements],
  );
  const inventoriesBySeedId = new Map(
    seedInventories.map((inventory) => [inventory.seedId, inventory]),
  );
  const findingsById = new Map(
    seedInventories.flatMap((inventory) =>
      inventory.findings.map(
        (finding) => [finding.findingId, finding] as const,
      ),
    ),
  );
  const lastPage = Math.max(
    0,
    Math.ceil(citationStatements.length / PAGE_SIZE) - 1,
  );
  const pageIndex = Math.min(page, lastPage);
  const pageStart = pageIndex * PAGE_SIZE;

  return (
    <div className="space-y-4">
      {seedInventories.toSorted(compareSeedInventoryDates).map((inventory) => (
        <details
          className="rounded-3xl border border-[var(--border)] bg-white/70 px-5 py-4"
          key={inventory.seedId}
        >
          <summary className="cursor-pointer text-sm font-semibold">
            {titleWithPublicationYear(
              inventory.seedTitle,
              inventory.seedPublicationYear,
            )}{" "}
            · {String(inventory.findings.length)} verified findings
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-sm text-[var(--text-muted)]">
              Inventory {humanizeCode(inventory.status)}
            </p>
            {inventory.reason && <p className="text-sm">{inventory.reason}</p>}
            {inventory.findings.map((finding) => (
              <FindingEvidence finding={finding} key={finding.findingId} />
            ))}
          </div>
        </details>
      ))}
      {citationStatements.length === 0 && (
        <p className="text-sm text-[var(--text-muted)]">
          No citation statements were extracted from the works examined by
          Discover.
        </p>
      )}
      {orderedStatements
        .slice(pageStart, pageStart + PAGE_SIZE)
        .map((statement) => {
          const inventory = inventoriesBySeedId.get(statement.seedId);
          return (
            <CitationStatement
              findingsById={findingsById}
              key={statement.statementId}
              outcomes={fidelity[statement.statementId] ?? []}
              statement={statement}
              {...(inventory ? { inventory } : {})}
            />
          );
        })}
      {lastPage > 0 && (
        <nav
          aria-label="Citation statement pages"
          className="flex flex-wrap items-center gap-3 text-sm"
        >
          <Button
            disabled={pageIndex === 0}
            onClick={() => setPage(pageIndex - 1)}
            variant="secondary"
          >
            Previous
          </Button>
          <span>
            Page {String(pageIndex + 1)} of {String(lastPage + 1)}
          </span>
          <Button
            disabled={pageIndex === lastPage}
            onClick={() => setPage(pageIndex + 1)}
            variant="secondary"
          >
            Next
          </Button>
        </nav>
      )}
    </div>
  );
}
