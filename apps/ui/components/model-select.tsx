"use client";

import { Input } from "@/components/ui/input";

export const KNOWN_MODELS = [
  { id: "claude-opus-4-6", label: "claude-opus-4-6", cost: "$5 / $25" },
  { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", cost: "$3 / $15" },
  { id: "claude-haiku-4-5", label: "claude-haiku-4-5", cost: "$1 / $5" },
] as const;

const selectClass =
  "h-11 rounded-2xl border border-[var(--border)] bg-white/70 px-4 text-sm";
const labelClass = "text-sm font-semibold text-[var(--text)]";
const hintClass = "text-xs text-[var(--text-muted)]";

function isKnownModel(value: string): boolean {
  return KNOWN_MODELS.some((m) => m.id === value);
}

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
  const known = isKnownModel(value);

  const select = (
    <>
      <select
        className={selectClass}
        value={known ? value : "__custom__"}
        onChange={(e) => {
          if (e.target.value === "__custom__") {
            onChange("");
          } else {
            onChange(e.target.value);
          }
        }}
      >
        {KNOWN_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} ({m.cost} per 1M tokens)
          </option>
        ))}
        <option value="__custom__">Custom model…</option>
      </select>
      {!known ? (
        <Input
          autoComplete="off"
          placeholder="Model ID, e.g. claude-sonnet-4-6"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
    </>
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
