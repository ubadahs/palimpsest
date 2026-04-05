/**
 * Prefer a path relative to the workspace root for UI copy; fall back to the
 * absolute path when it lies outside the root.
 */
export function pathRelativeToWorkspace(
  absolutePath: string,
  workspaceRoot: string,
): string {
  const root = workspaceRoot.replace(/\/+$/, "");
  if (absolutePath === root || absolutePath === `${root}/`) {
    return ".";
  }

  const prefix = `${root}/`;
  if (absolutePath.startsWith(prefix)) {
    return absolutePath.slice(prefix.length);
  }

  return absolutePath;
}
