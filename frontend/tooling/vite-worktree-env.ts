import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

function hasEnvironmentFiles(directory: string, mode: string): boolean {
  return [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`]
    .some((name) => existsSync(resolve(directory, name)));
}

export function resolveViteEnvironmentDirectory(repositoryRoot: string, mode: string): string {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  if (hasEnvironmentFiles(resolvedRepositoryRoot, mode)) return resolvedRepositoryRoot;
  try {
    const commonGitDirectory = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: resolvedRepositoryRoot, encoding: "utf8", windowsHide: true },
    ).trim();
    const primaryWorktree = resolve(dirname(commonGitDirectory));
    if (primaryWorktree !== resolvedRepositoryRoot && hasEnvironmentFiles(primaryWorktree, mode)) {
      return primaryWorktree;
    }
  } catch {
    // Source archives and CI checkouts may not expose Git worktree metadata.
  }
  return resolvedRepositoryRoot;
}
