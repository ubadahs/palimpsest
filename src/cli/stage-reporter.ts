import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { stageDefinitions } from "../contract/stages.js";
import type { StageKey } from "../contract/run-types.js";
import type { StageProgressEvent } from "../contract/workflow.js";
import { serializeProgressEvent } from "../contract/workflow.js";

export function log(stage: string, message: string): void {
  console.info(`[${stage}] ${message}`);
}

export type StageReporter = {
  onProgress: (event: {
    step: string;
    status: string;
    detail?: string;
    current?: number;
    total?: number;
  }) => void;
  log: (message: string) => void;
  logPath: string;
};

/**
 * Creates a stage-aware reporter that emits structured CF_PROGRESS events
 * (for the workflow panel) and human-readable log lines to both stdout and a
 * per-stage log file.
 */
export function createStageReporter(
  stageKey: StageKey,
  outputDir: string,
  familyIndex = 0,
): StageReporter {
  const def = stageDefinitions.find((s) => s.key === stageKey)!;
  const fileName =
    familyIndex > 0
      ? `${def.slug}.f${String(familyIndex)}.log`
      : `${def.slug}.log`;
  const logPath = resolve(outputDir, "logs", fileName);
  const tag =
    familyIndex > 0 ? `F${String(familyIndex + 1)}:${stageKey}` : stageKey;

  function writeToLog(line: string): void {
    appendFileSync(logPath, line + "\n", "utf8");
  }

  function onProgress(event: {
    step: string;
    status: string;
    detail?: string;
    current?: number;
    total?: number;
  }): void {
    const line = serializeProgressEvent({
      stage: stageKey,
      step: event.step,
      status: event.status as StageProgressEvent["status"],
      ...(event.detail != null ? { detail: event.detail } : {}),
      ...(event.current != null && event.total != null
        ? { current: event.current, total: event.total }
        : {}),
    });
    writeToLog(line);
    console.info(line);
  }

  function stageLog(message: string): void {
    const line = `[${tag}] ${message}`;
    writeToLog(line);
    console.info(line);
  }

  return { onProgress, log: stageLog, logPath };
}
