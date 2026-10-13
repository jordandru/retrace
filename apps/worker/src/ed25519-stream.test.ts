import assert from "node:assert/strict";
import test from "node:test";
import { publicFromPrivate } from "@retrace-dev/core";
import { createStreamingEd25519Signer } from "./ed25519-stream.js";

/** RFC 8032 §7.1, "Test Vectors for Ed25519" (https://www.rfc-editor.org/rfc/rfc8032.txt, read 2026-10-13), all five:
 *  TEST 1, 2, 3, 1024 and SHA(abc). Extracted from the RFC text by script, not by hand. */
const RFC8032_VECTORS = [
  {
    name: "TEST 1",
    secret: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    public: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    message:
      "",
    signature: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    name: "TEST 2",
    secret: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    public: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    message:
      "72",
    signature: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
  {
    name: "TEST 3",
    secret: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
    public: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    message:
      "af82",
    signature: "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
  },
  {
    name: "TEST 1024",
    secret: "f5e5767cf153319517630f226876b86c8160cc583bc013744c6bf255f5cc0ee5",
    public: "278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e",
    message:
      "08b8b2b733424243760fe426a4b54908632110a66c2f6591eabd3345e3e4eb98fa6e264bf09efe12ee50f8f54e9f77b1e355f6c50544e23f" +
      "b1433ddf73be84d879de7c0046dc4996d9e773f4bc9efe5738829adb26c81b37c93a1b270b20329d658675fc6ea534e0810a4432826bf58c" +
      "941efb65d57a338bbd2e26640f89ffbc1a858efcb8550ee3a5e1998bd177e93a7363c344fe6b199ee5d02e82d522c4feba15452f80288a82" +
      "1a579116ec6dad2b3b310da903401aa62100ab5d1a36553e06203b33890cc9b832f79ef80560ccb9a39ce767967ed628c6ad573cb116dbef" +
      "efd75499da96bd68a8a97b928a8bbc103b6621fcde2beca1231d206be6cd9ec7aff6f6c94fcd7204ed3455c68c83f4a41da4af2b74ef5c53" +
      "f1d8ac70bdcb7ed185ce81bd84359d44254d95629e9855a94a7c1958d1f8ada5d0532ed8a5aa3fb2d17ba70eb6248e594e1a2297acbbb39d" +
      "502f1a8c6eb6f1ce22b3de1a1f40cc24554119a831a9aad6079cad88425de6bde1a9187ebb6092cf67bf2b13fd65f27088d78b7e883c8759" +
      "d2c4f5c65adb7553878ad575f9fad878e80a0c9ba63bcbcc2732e69485bbc9c90bfbd62481d9089beccf80cfe2df16a2cf65bd92dd597b07" +
      "07e0917af48bbb75fed413d238f5555a7a569d80c3414a8d0859dc65a46128bab27af87a71314f318c782b23ebfe808b82b0ce26401d2e22" +
      "f04d83d1255dc51addd3b75a2b1ae0784504df543af8969be3ea7082ff7fc9888c144da2af58429ec96031dbcad3dad9af0dcbaaaf268cb8" +
      "fcffead94f3c7ca495e056a9b47acdb751fb73e666c6c655ade8297297d07ad1ba5e43f1bca32301651339e22904cc8c42f58c30c04aafdb" +
      "038dda0847dd988dcda6f3bfd15c4b4c4525004aa06eeff8ca61783aacec57fb3d1f92b0fe2fd1a85f6724517b65e614ad6808d6f6ee34df" +
      "f7310fdc82aebfd904b01e1dc54b2927094b2db68d6f903b68401adebf5a7e08d78ff4ef5d63653a65040cf9bfd4aca7984a74d371459867" +
      "80fc0b16ac451649de6188a7dbdf191f64b5fc5e2ab47b57f7f7276cd419c17a3ca8e1b939ae49e488acba6b965610b5480109c8b17b80e1" +
      "b7b750dfc7598d5d5011fd2dcc5600a32ef5b52a1ecc820e308aa342721aac0943bf6686b64b2579376504ccc493d97e6aed3fb0f9cd71a4" +
      "3dd497f01f17c0e2cb3797aa2a2f256656168e6c496afc5fb93246f6b1116398a346f1a641f3b041e989f7914f90cc2c7fff357876e506b5" +
      "0d334ba77c225bc307ba537152f3f1610e4eafe595f6d9d90d11faa933a15ef1369546868a7f3a45a96768d40fd9d03412c091c6315cf4fd" +
      "e7cb68606937380db2eaaa707b4c4185c32eddcdd306705e4dc1ffc872eeee475a64dfac86aba41c0618983f8741c5ef68d3a101e8a3b8ca" +
      "c60c905c15fc910840b94c00a0b9d0",
    signature: "0aab4c900501b3e24d7cdf4663326a3a87df5e4843b2cbdb67cbf6e460fec350aa5371b1508f9f4528ecea23c436d94b5e8fcd4f681e30a6ac00a9704a188a03",
  },
  {
    name: "TEST SHA(abc)",
    secret: "833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42",
    public: "ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf",
    message:
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e" +
      "2a9ac94fa54ca49f",
    signature: "dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704",
  },
];

const subtle = crypto.subtle;
const ED25519 = { name: "Ed25519" };

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

async function newJwk(): Promise<JsonWebKey> {
  const pair = await subtle.generateKey(ED25519, true, ["sign", "verify"]) as CryptoKeyPair;
  return await subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
}

/** Deterministic xorshift so a failure reproduces from its seed. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

/** Split `message` into random chunks, empty ones included. */
function chunks(message: Uint8Array, rand: () => number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < message.length) {
    const roll = rand();
    const size = roll < 0.05 ? 0 : roll < 0.6 ? Math.floor(rand() * 64) + 1 : roll < 0.9 ? Math.floor(rand() * 4096) + 1 : Math.floor(rand() * 262_144) + 1;
    out.push(message.subarray(i, Math.min(message.length, i + size)));
    i += size;
  }
  if (rand() < 0.3) out.push(new Uint8Array(0));
  return out;
}

function signTwoPass(jwk: JsonWebKey, message: Uint8Array, rand: () => number): Uint8Array {
  const signer = createStreamingEd25519Signer(jwk);
  try {
    const signature = signer.begin();
    for (const c of chunks(message, rand)) signature.nonce(c);
    for (const c of chunks(message, rand)) signature.challenge(c);
    return signature.finish();
  } finally {
    signer.dispose();
  }
}

async function webcrypto(jwk: JsonWebKey, message: Uint8Array) {
  const { alg: _alg, ...importable } = jwk as JsonWebKey & { alg?: string };
  const priv = await subtle.importKey("jwk", importable, ED25519, false, ["sign"]);
  const pub = await subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, ED25519, false, ["verify"]);
  return {
    sign: async () => new Uint8Array(await subtle.sign(ED25519, priv, message)),
    verify: (sig: Uint8Array) => subtle.verify(ED25519, pub, sig, message),
  };
}

test("RFC 8032 §7.1: all five Ed25519 vectors, in random chunkings, equal the RFC and WebCrypto", async () => {
  const rand = rng(8032);
  for (const v of RFC8032_VECTORS) {
    const jwk: JsonWebKey = { kty: "OKP", crv: "Ed25519", d: b64u(hex(v.secret)), x: b64u(hex(v.public)) };
    const message = hex(v.message);
    for (let round = 0; round < 5; round++) {
      assert.equal(toHex(signTwoPass(jwk, message, rand)), v.signature, `${v.name} round ${round}`);
    }
    const wc = await webcrypto(jwk, message);
    assert.equal(toHex(await wc.sign()), v.signature, `${v.name}: WebCrypto agrees with the RFC`);
    assert.equal(await wc.verify(hex(v.signature)), true, `${v.name}: WebCrypto verifies`);
  }
});

test("1,032 random keys and messages (0 B to 6 MiB) in random chunk sizes: byte-identical to subtle.sign, accepted by subtle.verify", { timeout: 600_000 }, async () => {
  const rand = rng(20261013);
  let large = 0;
  let total = 0;
  for (let i = 0; i < 1032; i++) {
    const jwk = await newJwk();
    // Sizes: eight of 1 to 6 MiB, the empty message, and otherwise mostly small with some up to 256 KiB.
    const size = i < 8 ? 1_048_576 + Math.floor(rand() * 5 * 1_048_576) : i === 8 ? 0 : rand() < 0.85 ? Math.floor(rand() * 4097) : Math.floor(rand() * 262_145);
    const message = new Uint8Array(size);
    for (let off = 0; off < size; off += 65_536) crypto.getRandomValues(message.subarray(off, Math.min(size, off + 65_536)));
    const streamed = signTwoPass(jwk, message, rand);
    const wc = await webcrypto(jwk, message);
    assert.equal(toHex(streamed), toHex(await wc.sign()), `case ${i}, ${size} bytes`);
    assert.equal(await wc.verify(streamed), true, `case ${i}: subtle.verify accepts`);
    if (size >= 1_048_576) large++;
    total += size;
  }
  assert.equal(large, 8);
  assert.ok(total > 8 * 1_048_576);
});

test("finish refuses unless pass 2 fed exactly pass 1's bytes, and releases no signature", async () => {
  const jwk = await newJwk();
  const signer = createStreamingEd25519Signer(jwk);
  const message = new TextEncoder().encode("{\"chain\":{\"ok\":true},\"events\":[]}");
  const altered = message.slice();
  altered[5] ^= 1;
  const cases: Array<[string, Uint8Array[], Uint8Array[]]> = [
    ["one byte differs", [message], [altered]],
    ["pass 2 is shorter", [message], [message.subarray(0, message.length - 1)]],
    ["pass 2 is longer", [message], [message, Uint8Array.of(0x20)]],
    ["pass 2 never ran", [message], []],
    ["pass 1 never ran", [], [message]],
  ];
  for (const [name, first, second] of cases) {
    const signature = signer.begin();
    for (const c of first) signature.nonce(c);
    for (const c of second) signature.challenge(c);
    assert.throws(() => signature.finish(), /signature refused: pass 2 did not feed the bytes pass 1 fed/, name);
    assert.throws(() => signature.finish(), /the signature has ended/, `${name}: a refused signature cannot be retried`);
  }
  signer.dispose();
});

test("the signature is a one-way state machine, and a disposed signer or signature refuses", async () => {
  const jwk = await newJwk();
  const signer = createStreamingEd25519Signer(jwk);
  const m = Uint8Array.of(1, 2, 3);
  const s1 = signer.begin();
  s1.nonce(m);
  s1.challenge(m);
  assert.throws(() => s1.nonce(m), /pass 1 has ended/);
  assert.equal(s1.finish().length, 64);
  assert.throws(() => s1.challenge(m), /the signature has ended/);
  const s2 = signer.begin();
  s2.nonce(m);
  s2.dispose();
  s2.dispose();
  assert.throws(() => s2.challenge(m), /the signature has ended/);
  assert.throws(() => s2.finish(), /the signature has ended/);
  signer.dispose();
  signer.dispose();
  assert.throws(() => signer.begin(), /signer: disposed/);
});

test("the signer refuses a key whose d does not derive its x, or a malformed JWK, and never puts key material in the error", async () => {
  const a = await newJwk();
  const b = await newJwk();
  const d = a.d!;
  const lastBits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(d.at(-1)!);
  const nonCanonical = d.slice(0, -1) + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[lastBits | 1];
  const cases: Array<[string, JsonWebKey, RegExp]> = [
    ["x from another key", { ...a, x: b.x }, /the public key derived from d does not equal x/],
    ["not OKP", { ...a, kty: "EC" }, /not an Ed25519 OKP JWK/],
    ["wrong curve", { ...a, crv: "X25519" }, /not an Ed25519 OKP JWK/],
    ["d missing", { ...a, d: undefined }, /JWK d is not 32 bytes/],
    ["d padded", { ...a, d: `${d}=` }, /JWK d is not 32 bytes/],
    ["d with a base64 (not base64url) character", { ...a, d: `+${d.slice(1)}` }, /JWK d is not 32 bytes/],
    ["d with a non-canonical last character", { ...a, d: nonCanonical }, /JWK d is not 32 bytes/],
    ["d of 31 bytes", { ...a, d: b64u(new Uint8Array(31)) }, /JWK d is not 32 bytes/],
    ["x of 33 bytes", { ...a, x: b64u(new Uint8Array(33)) }, /JWK x is not 32 bytes/],
  ];
  for (const [name, jwk, pattern] of cases) {
    let caught: unknown;
    try { createStreamingEd25519Signer(jwk); } catch (error) { caught = error; }
    assert.ok(caught instanceof Error, name);
    assert.match(caught.message, pattern, name);
    const text = `${caught.message} ${caught.stack ?? ""}`;
    assert.ok(!text.includes(d) && !text.includes(d.slice(0, 16)), `${name}: the error carries no part of d`);
  }
  assert.throws(() => createStreamingEd25519Signer(null as unknown as JsonWebKey), /not an Ed25519 OKP JWK/);
});

test("the signer exposes only the public JWK that publicFromPrivate gives, and serialises without key material", async () => {
  const jwk: JsonWebKey = { ...(await newJwk()), kid: "k1", alg: "Ed25519" } as JsonWebKey;
  const signer = createStreamingEd25519Signer(jwk);
  assert.deepEqual(signer.publicKey, publicFromPrivate(jwk));
  assert.equal((signer.publicKey as { d?: string }).d, undefined);
  const signature = signer.begin();
  for (const text of [JSON.stringify(signer), JSON.stringify(signature), JSON.stringify(Object.entries(signer)), JSON.stringify(Object.entries(signature))]) {
    assert.ok(!text.includes(jwk.d!), "no d in the serialised signer or signature");
  }
  assert.deepEqual(Object.keys(signer).sort(), ["begin", "dispose", "publicKey"]);
  assert.deepEqual(Object.keys(signature).sort(), ["challenge", "dispose", "finish", "nonce"]);
  signature.dispose();
  signer.dispose();
});
