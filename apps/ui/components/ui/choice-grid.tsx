"use client";

import { cn } from "@/lib/utils";

/**
 * One answer a reviewer can give. `code` is what gets stored and shown on the
 * badge; `name` and `test` are what a reviewer reads, so nobody has to
 * remember a code mid-session. Either `key` or the code's letter picks it.
 */
export type Choice<T extends string> = {
  value: T;
  code: string;
  key: string;
  name: string;
  test: string;
  tone: "success" | "danger" | "error" | "muted";
};

const toneClasses: Record<
  Choice<string>["tone"],
  { badge: string; ring: string }
> = {
  success: {
    badge: "bg-[var(--success)] text-white",
    ring: "border-[var(--success)]",
  },
  danger: {
    badge: "bg-[var(--danger)] text-white",
    ring: "border-[var(--danger)]",
  },
  error: {
    badge: "bg-[rgba(151,100,44,0.9)] text-white",
    ring: "border-[rgba(151,100,44,0.9)]",
  },
  muted: {
    badge: "bg-[var(--border-strong)] text-white",
    ring: "border-[var(--border-strong)]",
  },
};

/** The choice a key press stands for, if any. */
export function choiceForKey<T extends string>(
  choices: ReadonlyArray<Choice<T>>,
  key: string,
): Choice<T> | undefined {
  return choices.find(
    (choice) => choice.key === key || choice.code === key.toUpperCase(),
  );
}

/**
 * True when a key press belongs to a field the reviewer is typing in. A
 * focused radio button or checkbox is not one: after clicking a choice, the
 * shortcuts keep working.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement)
    return target.type !== "radio" && target.type !== "checkbox";
  return (
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export function ChoiceGrid<T extends string>({
  legend,
  name,
  choices,
  value,
  onChange,
  stacked = false,
  className,
}: {
  legend: string;
  name: string;
  choices: ReadonlyArray<Choice<T>>;
  value: T | "";
  onChange: (value: T) => void;
  /** One choice per row, for a narrow column. */
  stacked?: boolean;
  className?: string;
}) {
  return (
    <fieldset className={className}>
      <legend className="sr-only">{legend}</legend>
      <div className={cn("grid gap-2", !stacked && "sm:grid-cols-2")}>
        {choices.map((choice) => {
          const selected = value === choice.value;
          const tone = toneClasses[choice.tone];
          return (
            <label
              className={cn(
                "flex cursor-pointer gap-3 rounded-[18px] border-2 px-4 py-3 transition",
                selected
                  ? cn(tone.ring, "bg-[var(--panel-muted)]")
                  : "border-[var(--border)] bg-white hover:border-[var(--border-strong)]",
              )}
              key={choice.value}
            >
              <input
                checked={selected}
                className="sr-only"
                name={name}
                onChange={() => onChange(choice.value)}
                type="radio"
                value={choice.value}
              />
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold",
                  tone.badge,
                )}
              >
                {choice.code}
              </span>
              <span className="min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className="text-base font-semibold text-[var(--text)]">
                    {choice.name}
                  </span>
                  <kbd className="rounded border border-[var(--border)] px-1 font-mono text-[10px] text-[var(--text-muted)]">
                    {choice.key}
                  </kbd>
                </span>
                <span className="block text-sm leading-6 text-[var(--text-muted)]">
                  {choice.test}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
