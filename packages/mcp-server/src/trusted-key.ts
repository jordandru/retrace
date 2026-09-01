/** Trusted issuer key resolution, shared by retrace-export verify/checkpoint, reconcile and doctor. */
import { readFileSync } from "node:fs";

/** Load a public JWK from a file path, an https URL, or an inline JSON string. Plain http is refused: a key fetched over
 *  an interceptable channel is not a trusted key. Accepts a bare JWK or a /.well-known/retrace-pubkey document. */
export async function loadPublicKey(src: string, label: string): Promise<JsonWebKey> {
  let raw: any;
  if (/^https:/i.test(src)) raw = await (await fetch(src)).json();
  else if (/^http:/i.test(src)) throw new Error(`${label}: refusing to fetch a trusted key over plain http (${src}) — use https or a local file`);
  else if (src.trim().startsWith("{")) raw = JSON.parse(src);
  else raw = JSON.parse(readFileSync(src, "utf8"));
  const jwk = raw?.public_key ?? raw;
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error(`${label}: not an Ed25519 public JWK`);
  if ("d" in jwk) throw new Error(`${label}: that is a PRIVATE key — pass the public JWK`);
  return jwk;
}

/** Resolve the trusted issuer key for verification: explicit flag, RETRACE_PUBKEY, or the issuer's https well-known URL. */
export async function resolveTrustedKey(flag: unknown, baseUrl = process.env.RETRACE_URL): Promise<{ key: JsonWebKey; from: string } | undefined> {
  if (flag) return { key: await loadPublicKey(String(flag), "--pubkey"), from: `--pubkey ${flag}` };
  if (process.env.RETRACE_PUBKEY) return { key: await loadPublicKey(process.env.RETRACE_PUBKEY, "RETRACE_PUBKEY"), from: "RETRACE_PUBKEY" };
  if (baseUrl && /^https:/i.test(baseUrl)) {
    const url = baseUrl.replace(/\/+$/, "") + "/.well-known/retrace-pubkey";
    try { return { key: await loadPublicKey(url, url), from: url }; }
    catch (e: any) { console.error(`  (could not load the issuer key from ${url}: ${e?.message ?? e})`); }
  }
  return undefined;
}
