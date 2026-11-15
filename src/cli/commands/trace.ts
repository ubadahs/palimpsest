import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { inspectTrace } from "../../telemetry/trace.js";
import {
  readPersistedCalls,
  rebuildRunCostSummary,
} from "../../pipeline/cost-summary.js";

/** Read only: projections can always be rebuilt from the saved journal. */
export function runTraceCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { root: { type: "string" }, calls: { type: "boolean" } },
  });
  if (!values.root)
    throw new Error(
      "Usage: trace --root <run-or-experiment-directory> [--calls]",
    );
  const root = resolve(values.root);
  if (!existsSync(resolve(root, "traces", "sessions")))
    throw new Error(`No persisted traces in ${root}`);
  console.info(
    JSON.stringify(
      {
        root,
        ...inspectTrace(root),
        cost: rebuildRunCostSummary(root),
        ...(values.calls ? { calls: readPersistedCalls(root) } : {}),
      },
      null,
      2,
    ),
  );
}
