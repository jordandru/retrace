/** Local signing key management: ~/.retrace/signing-key.json (private JWK), auto-created on first use. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { generateSigningKey, publicFromPrivate, keyId } from "@retrace/core";

export function keyPath(): string {
  return process.env.RETRACE_SIGNING_KEY_FILE ?? join(homedir(), ".retrace", "signing-key.json");
}

export function loadSigningKey(): JsonWebKey | null {
  const p = keyPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export async function ensureSigningKey(): Promise<{ privateKey: JsonWebKey; publicKey: JsonWebKey; kid: string; path: string; created: boolean }> {
  const p = keyPath();
  const existing = loadSigningKey();
  if (existing) return { privateKey: existing, publicKey: publicFromPrivate(existing), kid: await keyId(publicFromPrivate(existing)), path: p, created: false };
  const kp = await generateSigningKey();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(kp.privateKey, null, 2) + "\n");
  try { chmodSync(p, 0o600); } catch {}
  return { ...kp, path: p, created: true };
}
