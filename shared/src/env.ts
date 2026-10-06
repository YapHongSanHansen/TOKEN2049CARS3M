import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The monorepo root (the directory holding shared/), wherever a workspace script is started from. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "shared", "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/** The root env files in precedence order: .env.local (your secrets) wins over .env. */
export function rootEnvPaths(): string[] {
  return [".env.local", ".env"].map(name => join(repoRoot(), name)).filter(path => existsSync(path));
}

/** @deprecated use rootEnvPaths */
export function rootEnvPath(): string | undefined {
  return rootEnvPaths()[0];
}

/** Relative paths in .env are relative to the repo root, not to the workspace that runs. */
export function fromRepoRoot(path: string): string {
  return path === ":memory:" || isAbsolute(path) ? path : resolve(repoRoot(), path);
}

export type ChainMode = "simulated" | "preprod";

export function chainModeFrom(value: string | undefined): ChainMode {
  const mode = (value ?? "simulated").trim() || "simulated";
  if (mode !== "simulated" && mode !== "preprod") throw new Error(`CHAIN_MODE must be "simulated" or "preprod", not "${mode}"`);
  return mode;
}
