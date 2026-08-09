import {
  formatRateFraction,
  formatRateValue,
  humanizeCode,
  rateLabel,
  type ReportCountLike,
  type ReportRateLike,
} from "@/lib/report-format";

export function MetricTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div
      className="rounded-[20px] border border-[var(--border)] bg-white/60 p-4"
      title={hint}
    >
      <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-[var(--text)]">
        {value}
      </p>
    </div>
  );
}

export function CountLine({ count }: { count: ReportCountLike }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-[var(--text-muted)]" title={count.population}>
        {humanizeCode(count.metricId.split(".").at(-1) ?? count.metricId)}
      </span>
      <span className="font-semibold tabular-nums text-[var(--text)]">
        {count.count}
      </span>
    </div>
  );
}

export function RateCard({ rate }: { rate: ReportRateLike }) {
  const pct =
    rate.value == null || rate.denominator === 0 ? 0 : rate.value * 100;
  return (
    <div
      className="rounded-[20px] border border-[var(--border)] bg-white/60 p-4"
      title={`${rate.numeratorDefinition} / ${rate.denominatorDefinition}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
            {rateLabel(rate.metricId)}
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-[var(--text)]">
            {formatRateValue(rate)}
          </p>
        </div>
        <p className="text-xs tabular-nums text-[var(--text-muted)]">
          {formatRateFraction(rate)}
        </p>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--panel-muted)]">
        <div
          className="h-full rounded-full bg-[var(--accent)]"
          style={{ width: `${String(Math.min(100, pct))}%` }}
        />
      </div>
      <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
        {rate.populationLabel}
      </p>
    </div>
  );
}
