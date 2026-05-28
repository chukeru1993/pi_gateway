import * as path from "node:path";

const ALLOWED_CWD_PREFIXES = (process.env.PI_CWD_ROOT || "/workspace").split(",");
const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|(-[a-zA-Z]*f[a-zA-Z]*r))\s+[\/~]/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*)\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?[\/~]/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*)\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?[\/~]/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /:\(\)\s*\{\s*:\|:\&\s*\}\s*;/,
  /\bchmod\s+(777|666|a\+rwx)\s+[\/~]/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
  /\bkill\s+-9\s+1\b/,
  />\s*\/dev\/sd[a-z]/,
  /\bnc\s+.*-e\s/,
  /\bbash\s+-i\s+.*\/dev\/tcp/,
  /\bcurl\s.*\|\s*(ba)?sh/,
  /\bwget\s.*\|\s*(ba)?sh/,
];

export function validateCwd(cwd: string): void {
  const abs = path.resolve(cwd);
  const isAllowed = ALLOWED_CWD_PREFIXES.some((p) => {
    const resolved = path.resolve(p);
    return abs === resolved || abs.startsWith(resolved + "/");
  });
  if (!isAllowed) {
    throw new Error("cwd not allowed");
  }
}

export function validateBash(command: string): void {
  const cmd = command.trim();
  if (BLOCKED_PATTERNS.some((p) => p.test(cmd))) {
    throw new Error("Command blocked by security policy");
  }
}
