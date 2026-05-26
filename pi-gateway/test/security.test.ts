import { describe, it, expect } from "vitest";
import { validateCwd, validateBash } from "../src/security.js";

describe("Security - validateCwd", () => {
  it("cwd 在白名单内 → 通过", () => {
    expect(() => validateCwd("/workspace/project")).not.toThrow();
  });

  it("cwd 不在白名单内 → 抛错", () => {
    expect(() => validateCwd("/etc")).toThrow("cwd not allowed");
  });
});

describe("Security - validateBash", () => {
  it("正常命令 → 通过", () => {
    expect(() => validateBash("ls -la")).not.toThrow();
    expect(() => validateBash("echo hello")).not.toThrow();
  });

  it("危险命令 rm -rf / → 400", () => {
    expect(() => validateBash("rm -rf /")).toThrow("Command blocked");
  });

  it("mkfs → 被拒", () => {
    expect(() => validateBash("mkfs.ext4 /dev/sda")).toThrow("Command blocked");
  });
});
