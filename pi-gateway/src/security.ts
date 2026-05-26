import * as path from "node:path";

const ALLOWED_CWD_PREFIXES = (process.env.PI_CWD_ROOT || "/workspace").split(",");
const BLOCKED_PATTERNS = [/^rm\s+-rf\s+\//, /^mkfs/];

export function validateCwd(cwd: string): void {
  const abs = path.resolve(cwd);
  if (!ALLOWED_CWD_PREFIXES.some((p) => abs.startsWith(path.resolve(p)))) {
    throw new Error("cwd not allowed");
  }
}

export function validateBash(command: string): void {
  if (BLOCKED_PATTERNS.some((p) => p.test(command.trim()))) {
    throw new Error("Command blocked by security policy");
  }
}
