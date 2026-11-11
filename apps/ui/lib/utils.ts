import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Compact date+time: "Apr 9, 1:13 AM" */
export function formatDateCompact(value: string | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/** Time-only: "1:13 AM" */
export function formatTime(value: string | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatDuration(
  startedAt: string | undefined,
  finishedAt: string | undefined,
): string {
  if (!startedAt) {
    return "—";
  }

  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const start = new Date(startedAt).getTime();
  const delta = Math.max(0, end - start);
  const minutes = Math.floor(delta / 60_000);
  const seconds = Math.floor((delta % 60_000) / 1_000);

  if (minutes === 0) {
    return `${String(seconds)}s`;
  }

  return `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`;
}

/** The server's own `error` text when it sent one, else the raw body. */
async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && "error" in body)
      return String(body.error);
  } catch {
    // Not JSON; the text itself is the message.
  }
  return text || `HTTP ${String(response.status)}`;
}

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

/** Request options that POST `body` as JSON. */
export function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
