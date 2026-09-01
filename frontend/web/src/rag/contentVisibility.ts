import type { JojoContentAccess } from "@jojo/content";

export function isContentVisible(access: JojoContentAccess | undefined, signedIn: boolean): boolean {
  return access !== "authenticated" || signedIn;
}
