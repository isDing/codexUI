import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const hashToken = (token: string, secret: string): string =>
  createHash("sha256").update(secret).update("\0").update(token).digest("hex");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, expectedText] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedText) return false;
  const expected = Buffer.from(expectedText, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
