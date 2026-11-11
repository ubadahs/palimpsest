"use client";

import { useEffect, useState } from "react";

export const REVIEWER_STORAGE_KEY = "palimpsest.reviewer";

/** The reviewer's name, asked once and remembered on this machine. */
export function useStoredReviewer(): readonly [string, (name: string) => void] {
  const [reviewer, setReviewer] = useState("");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(REVIEWER_STORAGE_KEY);
      if (stored) setReviewer(stored);
    } catch {
      // Storage may be unavailable; the field still works for the session.
    }
  }, []);

  function remember(name: string) {
    setReviewer(name);
    try {
      window.localStorage.setItem(REVIEWER_STORAGE_KEY, name);
    } catch {
      // Ignore storage failures.
    }
  }

  return [reviewer, remember] as const;
}
