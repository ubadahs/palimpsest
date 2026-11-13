"use client";

const KNOWN_MODELS = [
  { id: "claude-fable-5-2", label: "claude-fable-5-2", cost: "$8 / $40" },
  { id: "claude-opus-5-5", label: "claude-opus-5-5", cost: "$4 / $20" },
  { id: "claude-sonnet-5-5", label: "claude-sonnet-5-5", cost: "$2 / $10" },
  { id: "claude-haiku-5-5", label: "claude-haiku-5-5", cost: "$0.10 / $0.50" },
] as const;

const selectClass =
  "h-11 rounded-2xl border border-[var(--border)] bg-white/70 px-4 text-sm";
const labelClass = "text-sm font-semibold text-[var(--text)]";
const hintClass = "text-xs text-[var(--text-muted)]";

// ---------------------------------------------------------------------------
// ModelSelect
// ---------------------------------------------------------------------------

type ModelSelectProps = {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  description?: string;
  className?: string;
};

export function ModelSelect({
  value,
  onChange,
  label,
  description,
  className,
}: ModelSelectProps) {
  const select = (
    <select
      className={selectClass}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {KNOWN_MODELS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label} ({m.cost} per 1M tokens)
        </option>
      ))}
    </select>
  );

  if (!label) {
    return <div className={`grid gap-2 ${className ?? ""}`}>{select}</div>;
  }

  return (
    <label className={`grid gap-2 ${className ?? ""}`}>
      <span className={labelClass}>{label}</span>
      {description ? <span className={hintClass}>{description}</span> : null}
      {select}
    </label>
  );
}

// ---------------------------------------------------------------------------
// ModelWithThinking
// ---------------------------------------------------------------------------

type ModelWithThinkingProps = {
  model: string;
  onModelChange: (value: string) => void;
  thinking: boolean;
  onThinkingChange: (value: boolean) => void;
  label: string;
  description?: string;
  thinkingLabel?: string;
  thinkingDescription?: string;
  modelClassName?: string;
};

export function ModelWithThinking({
  model,
  onModelChange,
  thinking,
  onThinkingChange,
  label,
  description,
  thinkingLabel = "Thinking",
  thinkingDescription,
  modelClassName,
}: ModelWithThinkingProps) {
  return (
    <>
      <ModelSelect
        label={label}
        {...(description != null ? { description } : {})}
        value={model}
        onChange={onModelChange}
        {...(modelClassName != null ? { className: modelClassName } : {})}
      />
      <div className="grid gap-1 self-end pb-1">
        <label className="grid cursor-pointer gap-1">
          <span className="flex items-center gap-3 text-sm text-[var(--text)]">
            <input
              checked={thinking}
              className="size-4 accent-[var(--accent)]"
              type="checkbox"
              onChange={(e) => onThinkingChange(e.target.checked)}
            />
            {thinkingLabel}
          </span>
          {thinkingDescription ? (
            <span className="pl-7 text-xs text-[var(--text-muted)]">
              {thinkingDescription}
            </span>
          ) : null}
        </label>
      </div>
    </>
  );
}
