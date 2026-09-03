import { createHash } from "node:crypto";

import { canonicalSerialize } from "./canonical-serialize.js";

export { canonicalSerialize, compareCodeUnits } from "./canonical-serialize.js";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** SHA-256 over {@link canonicalSerialize}; stable across object key order. */
export function canonicalSha256(value: unknown): string {
  return sha256Text(canonicalSerialize(value));
}

/**
 * Build a namespaced stable ID from explicitly selected semantic identity
 * inputs. Callers must keep timestamps and other observational metadata out of
 * `identityInputs`.
 */
export function buildStableId(
  namespace: string,
  identityInputs: unknown,
): string {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) {
    throw new TypeError(
      `Stable ID namespace must match ^[a-z][a-z0-9-]*$: ${namespace}`,
    );
  }
  return `${namespace}_${canonicalSha256({
    identityVersion: 1,
    identityInputs,
  })}`;
}
