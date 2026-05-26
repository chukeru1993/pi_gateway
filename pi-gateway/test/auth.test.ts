import { describe, it, expect, afterAll } from "vitest";
import * as crypto from "node:crypto";
import { verifyToken, generateToken } from "../src/auth.js";

describe("Auth - JWT", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  afterAll(() => {
    process.env.JWT_SECRET = originalJwtSecret;
  });

  it("正确 token 验证通过", () => {
    process.env.JWT_SECRET = "test-secret-123";
    const token = generateToken("user_1");
    const result = verifyToken(token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("user_1");
  });

  it("无 token → null", () => {
    process.env.JWT_SECRET = "test-secret-123";
    expect(verifyToken("")).toBeNull();
  });

  it("错误 token → null", () => {
    process.env.JWT_SECRET = "test-secret-123";
    expect(verifyToken("invalid.token.here")).toBeNull();
  });

  it("缺少 JWT_SECRET 时 verifyToken 返回 null", () => {
    delete process.env.JWT_SECRET;
    const token = generateToken("user_1");
    expect(verifyToken(token)).toBeNull();
  });

  it("过期 token → null", () => {
    process.env.JWT_SECRET = "test-secret-123";
    const expiredToken = generateToken("user_1", -3600);
    expect(verifyToken(expiredToken)).toBeNull();
  });

  it("authHook 无 token 抛出 401", async () => {
    process.env.JWT_SECRET = "test-secret-123";
    try {
      await (await import("../src/auth.js")).authHook({
        headers: {},
      } as any);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.statusCode).toBe(401);
    }
  });

  it("authHook 正确 token 不抛异常", async () => {
    process.env.JWT_SECRET = "test-secret-123";
    const token = generateToken("user_1");
    await (await import("../src/auth.js")).authHook({
      headers: { authorization: `Bearer ${token}` },
    } as any);
  });
});
