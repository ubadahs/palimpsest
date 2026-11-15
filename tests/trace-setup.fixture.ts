import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Exercise real disk persistence without mixing synthetic calls with run data.
const root = mkdtempSync(join(tmpdir(), "palimpsest-test-traces-"));
const previous = process.env["PALIMPSEST_TRACE_ROOT"];
process.env["PALIMPSEST_TRACE_ROOT"] = root;
afterAll(() => {
  if (previous === undefined) delete process.env["PALIMPSEST_TRACE_ROOT"];
  else process.env["PALIMPSEST_TRACE_ROOT"] = previous;
  rmSync(root, { recursive: true, force: true });
});
