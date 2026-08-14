import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const password = process.env.CODEXUI_PASSWORD;
if (!password || password.length < 12) {
  console.error("Set CODEXUI_PASSWORD to a password with at least 12 characters.");
  process.exit(1);
}

const scrypt = promisify(scryptCallback);
const salt = randomBytes(16).toString("base64url");
const derived = await scrypt(password, salt, 64);
console.log(`scrypt$${salt}$${Buffer.from(derived).toString("base64url")}`);
