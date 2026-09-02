import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SCHEME = "scrypt";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${SCHEME}:${salt.toString("base64url")}:${derivedKey.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== SCHEME) return false;
  const [, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, "base64url");
  const expected = Buffer.from(hashB64!, "base64url");
  const derivedKey = (await scrypt(password, salt, expected.length)) as Buffer;
  if (derivedKey.length !== expected.length) return false;
  return timingSafeEqual(derivedKey, expected);
}

// A pre-computed hash to verify against when no such user exists, so a
// login attempt against an unknown email takes the same time as one against
// a real account with a wrong password.
let dummyHashPromise: Promise<string> | undefined;

export function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(24).toString("base64url"));
  return dummyHashPromise;
}
