import * as crypto from "node:crypto";

function getJwtSecret(): string {
  return process.env.JWT_SECRET || "";
}

export function verifyToken(token: string): { userId: string } | null {
  const secret = getJwtSecret();
  if (!token || !secret) return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const keyBytes = Buffer.from(secret);
    const expectedSig = crypto.createHmac("sha256", keyBytes)
      .update(`${parts[0]}.${parts[1]}`)
      .digest("base64url");
    if (parts[2] !== expectedSig) return null;

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));

    if (payload.exp && Date.now() >= payload.exp * 1000) return null;
    if (!payload.sub) return null;

    return { userId: payload.sub };
  } catch {
    return null;
  }
}

export async function authHook(
  req: { headers: Record<string, string | undefined> },
): Promise<void> {
  const auth = req.headers.authorization;
  const token = auth?.replace("Bearer ", "") ?? "";
  if (!verifyToken(token)) {
    throw { statusCode: 401, message: "Unauthorized" };
  }
}

export function generateToken(userId: string, expiresInSeconds = 86400): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSeconds }),
  ).toString("base64url");

  const keyBytes = Buffer.from(getJwtSecret() || "dev-secret");
  const signature = crypto.createHmac("sha256", keyBytes).update(`${header}.${payload}`).digest("base64url");

  return `${header}.${payload}.${signature}`;
}
