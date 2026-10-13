/**
 * The full-project export, built and signed in memory bounded by one page of events (export-cache handoff db4bb0d6
 * §4b, §4d, §4e).
 *
 * The hourly cache refresh built the export with `buildExportBundle` and `JSON.stringify`, holding the whole ledger
 * several times over (every row, the canonical string it signs, the JSON it stores), and stopped finishing at about
 * 16.9k events. This produces the same bytes, reading one snapshot of the ledger three times:
 * - pass 0: the chain verdict exactly as `verifyChain` gives it, the event count, the policy documents
 *   `buildExportBundle` selects, and the exact length of the served bytes;
 * - pass 1: the signed message M = canonical(bundle without `signature`), to the signer's nonce;
 * - pass 2: M again, to the signer's challenge, and the served bytes, `JSON.stringify(bundle)` in its own key order
 *   with `signature` last, to the sink.
 * The head (seq and hash) and `generated_at` are pinned before pass 0 and every page is bounded by the pinned seq, so
 * events appended during the build stay out. Every pass keeps a SHA-256 of the canonical events it read; a pass that
 * disagrees with pass 0, or whose last event is not the pinned head, throws before the signature exists, so the sink
 * never receives the closing bytes. The signer separately refuses to sign unless pass 2 fed it pass 1's bytes.
 */
import { Event } from "./schema.js";
import { ChainHead, EventStore } from "./store.js";
import { ChainVerifier, canonicalize } from "./chain.js";
import { EXPORT_FORMAT, ExportBundle } from "./export.js";
import { PolicyDocument, collectReferencedPolicies, documentMapKey } from "./policy.js";
import { ProducerKey } from "./producer-sig.js";
import { encodeSignature, keyId } from "./signing.js";
import type { ExportSigner } from "./export-signer.js";

/** Default page bounds. Rows bound the D1 result; characters bound the memory a page takes (V8 stores a string with any
 *  character above U+00FF at two bytes per character, so a page of bodies is at most about 4 MB of string). */
export const EXPORT_PAGE_ROWS = 1000;
export const EXPORT_PAGE_CHARS = 2_000_000;
/** Bytes of `,"signature":"<86 characters of base64url>"`, the field an Ed25519 signature adds to the served bytes. */
const SIGNATURE_FIELD_BYTES = 101;
const WRITE_CHUNK = 65_536;

export interface IncrementalDigest {
  update(chunk: Uint8Array): unknown;
  digest(): Uint8Array;
}

export interface ExportByteSink {
  /** Takes ownership of `chunk`; resolves when the destination can take more (backpressure). */
  write(chunk: Uint8Array): Promise<void>;
}

/** What the builder reads: an EventStore has all of it, `eventsPage` included when the store supports streaming. */
export type ExportPageSource = Pick<EventStore, "head" | "get" | "listPolicies" | "eventsPage">;

export interface StreamingExportOptions {
  /** Signs the bundle; without one the bundle is unsigned, as `buildExportBundle` without a key. */
  signer?: ExportSigner;
  issuerName?: string;
  producers?: ProducerKey[];
  now?: Date;
  /** An incremental SHA-256, for the cross-pass check (core carries no hash implementation of its own). */
  sha256: () => IncrementalDigest;
  pageRows?: number;
  pageChars?: number;
  /** Called after each page of each pass, for tests and measurement. */
  onPage?: (page: { pass: 0 | 1 | 2; index: number; rows: number }) => void;
}

const encoder = new TextEncoder();
const COMMA = Uint8Array.of(0x2c);

/** Bytes a string takes in UTF-8 as TextEncoder writes it: a lone surrogate becomes U+FFFD, three bytes. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** `JSON.stringify(shell)` split around an open `events` array: the text before the events and the text after them,
 *  without the closing brace. `keys` gives the order (insertion order for the served bytes, sorted for M); `value`
 *  serialises one member. Undefined members are skipped, as JSON.stringify and canonicalize skip them. */
function around(shell: Record<string, unknown>, keys: string[], value: (v: unknown) => string): { before: string; after: string } {
  let before = "{";
  let after = "";
  let open = false;
  let first = true;
  for (const k of keys) {
    const v = shell[k];
    if (k !== "events" && v === undefined) continue;
    const member = `${first ? "" : ","}${JSON.stringify(k)}:`;
    first = false;
    if (k === "events") {
      before += `${member}[`;
      after = "]";
      open = true;
    } else if (open) after += member + value(v);
    else before += member + value(v);
  }
  if (!open) throw new Error("streaming export: the bundle has no events member");
  return { before, after };
}

function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Collects bytes into WRITE_CHUNK pieces for the sink. Content never reaches the declared length: `push` refuses
 * anything past `contentLimit`, the declared length less the closing bytes, and only `close` may write those. A
 * fixed-length R2 put stores the object as soon as the declared length has arrived, even if the writer is aborted
 * afterwards (observed in workerd), so bytes that outgrew pass 0's count must fail before they could complete it.
 */
class ChunkedWriter {
  private buf = new Uint8Array(WRITE_CHUNK);
  private pos = 0;
  private flushed = 0;
  constructor(private sink: ExportByteSink, private readonly contentLimit: number, private readonly declared: number) {}
  get total(): number {
    return this.flushed + this.pos;
  }
  async push(bytes: Uint8Array): Promise<void> {
    if (this.total + bytes.length > this.contentLimit) throw new Error(`streaming export: the served bytes outgrew pass 0's count of ${this.contentLimit} before the closing bytes`);
    await this.append(bytes);
  }
  /** The closing bytes, which alone may complete the declared length. */
  async close(closing: Uint8Array): Promise<void> {
    if (this.total !== this.contentLimit || this.total + closing.length !== this.declared) {
      throw new Error(`streaming export: ${this.total + closing.length} bytes built, pass 0 counted ${this.declared}`);
    }
    await this.append(closing);
    await this.flush();
  }
  private async append(bytes: Uint8Array): Promise<void> {
    let off = 0;
    while (off < bytes.length) {
      const n = Math.min(bytes.length - off, this.buf.length - this.pos);
      this.buf.set(bytes.subarray(off, off + n), this.pos);
      this.pos += n;
      off += n;
      if (this.pos === this.buf.length) await this.flush();
    }
  }
  private async flush(): Promise<void> {
    if (!this.pos) return;
    const chunk = this.buf.subarray(0, this.pos);
    this.buf = new Uint8Array(WRITE_CHUNK);
    this.pos = 0;
    this.flushed += chunk.length;
    await this.sink.write(chunk);
  }
}

/**
 * One full-project export of one project, planned (pass 0) and then written (passes 1 and 2). `plan` pins the snapshot
 * and computes everything the bytes depend on; `write` emits exactly `bytes` bytes or throws.
 */
export class StreamedFullExport {
  private constructor(
    private readonly source: ExportPageSource,
    private readonly opts: StreamingExportOptions,
    readonly project: string,
    /** The pinned head; null for a project with no events. */
    readonly head: ChainHead | null,
    readonly generated_at: string,
    readonly total_events: number,
    /** Exact length of the served bytes, signature included. */
    readonly bytes: number,
    private readonly eventsDigest: Uint8Array,
    private readonly served: { before: string; after: string },
    private readonly signed: { before: string; after: string } | undefined,
    readonly chain: ExportBundle["chain"],
  ) {}

  get head_hash(): string | undefined {
    return this.chain.head_hash;
  }

  static async plan(source: ExportPageSource, project: string, opts: StreamingExportOptions): Promise<StreamedFullExport> {
    const rows = opts.pageRows ?? EXPORT_PAGE_ROWS;
    const chars = opts.pageChars ?? EXPORT_PAGE_CHARS;
    if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(chars) || chars < 1) throw new Error("streaming export: page bounds must be positive integers");
    const options = { ...opts, pageRows: rows, pageChars: chars };
    const head = await source.head(project);
    const generated_at = (opts.now ?? new Date()).toISOString();
    const docs = source.listPolicies ? await source.listPolicies(project, 100_000) : undefined;
    const activationIds = new Set((docs ?? []).map((d) => d.envelope.activation.event_id));
    const presentActivations = new Set<string>();
    const referenced = new Set<string>();
    const verifier = new ChainVerifier();
    const digest = opts.sha256();
    let count = 0;
    let eventBytes = 0;
    let last: Event | undefined;
    let index = 0;
    for await (const page of snapshotPages(source, project, head, rows, chars)) {
      for (const e of page) {
        if (count > 0) {
          digest.update(COMMA);
          eventBytes += 1;
        }
        digest.update(encoder.encode(canonicalize(e)));
        eventBytes += utf8Length(JSON.stringify(e));
        await verifier.push(e);
        if (activationIds.has(e.id)) presentActivations.add(e.id);
        count++;
        last = e;
      }
      if (docs) for (const d of collectReferencedPolicies(page, docs)) referenced.add(documentMapKey(d.body.project, d.digest));
      opts.onPage?.({ pass: 0, index: index++, rows: page.length });
    }
    assertPinnedHead(head, last, count, count, "pass 0");

    // The policy documents buildExportBundle selects for a full export: those an event references, then those whose
    // activation event is exported. buildExportBundle also fetches an activation event it did not export and adds it as
    // context when it belongs to the project; in a snapshot such an event can only be newer than the pinned head (the
    // document was activated after it), so that document is left out, as a build at the pinned head would leave it out.
    let policies: PolicyDocument[] | undefined;
    if (docs) {
      const byKey = new Map(docs.filter((d) => referenced.has(documentMapKey(d.body.project, d.digest))).map((d) => [documentMapKey(d.body.project, d.digest), d] as const));
      for (const d of docs) if (presentActivations.has(d.envelope.activation.event_id)) byKey.set(documentMapKey(d.body.project, d.digest), d);
      for (const [key, d] of byKey) {
        if (presentActivations.has(d.envelope.activation.event_id)) continue;
        const activation = await source.get(d.envelope.activation.event_id);
        if (activation && activation.project === project) byKey.delete(key);
      }
      if (byKey.size) policies = [...byKey.values()];
    }

    const chain = { ...verifier.result(), head_hash: last?.hash, total_events: count };
    const shell: Record<string, unknown> = {
      format: EXPORT_FORMAT,
      generated_at,
      scope: { project },
      chain,
      events: [],
      context_events: 0,
    };
    if (opts.producers?.length) shell.producers = opts.producers;
    if (policies) shell.policies = policies;
    if (opts.signer) {
      const pub = opts.signer.publicKey;
      shell.issuer = { kid: await keyId(pub), alg: "Ed25519", public_key: pub, name: opts.issuerName };
    }
    const served = around(shell, Object.keys(shell), (v) => JSON.stringify(v));
    const signed = opts.signer ? around(shell, Object.keys(shell).sort(), canonicalize) : undefined;
    const bytes = utf8Length(served.before) + eventBytes + utf8Length(served.after) + (opts.signer ? SIGNATURE_FIELD_BYTES : 0) + 1;
    return new StreamedFullExport(source, options, project, head, generated_at, count, bytes, digest.digest(), served, signed, chain);
  }

  /** Passes 1 and 2: exactly `bytes` bytes to `sink`, or a throw before the last of them. */
  async write(sink: ExportByteSink): Promise<void> {
    const signature = this.signed ? this.opts.signer!.begin() : undefined;
    try {
      if (signature) {
        signature.nonce(encoder.encode(this.signed!.before));
        await this.replay(1, (canonical) => signature.nonce(canonical));
        signature.nonce(encoder.encode(`${this.signed!.after}}`));
      }
      const out = new ChunkedWriter(sink, this.bytes - (this.signed ? SIGNATURE_FIELD_BYTES : 0) - 1, this.bytes);
      await out.push(encoder.encode(this.served.before));
      if (signature) signature.challenge(encoder.encode(this.signed!.before));
      await this.replay(2, (canonical) => signature?.challenge(canonical), async (e, first) => {
        if (!first) await out.push(COMMA);
        await out.push(encoder.encode(JSON.stringify(e)));
      });
      if (signature) signature.challenge(encoder.encode(`${this.signed!.after}}`));
      await out.push(encoder.encode(this.served.after));
      let close = "}";
      if (signature) {
        const sig = signature.finish();
        if (sig.length !== 64) throw new Error("streaming export: the signer returned a signature that is not 64 bytes");
        close = `,"signature":${JSON.stringify(encodeSignature(sig))}}`;
      }
      await out.close(encoder.encode(close));
    } catch (error) {
      signature?.dispose();
      throw error;
    }
  }

  /** Re-reads the snapshot, handing each event's canonical bytes to `canonical` and the event to `event`; throws unless
   *  this pass read exactly pass 0's events. */
  private async replay(pass: 1 | 2, canonical: (bytes: Uint8Array) => void, event?: (e: Event, first: boolean) => Promise<void>): Promise<void> {
    const digest = this.opts.sha256();
    let count = 0;
    let last: Event | undefined;
    let index = 0;
    for await (const page of snapshotPages(this.source, this.project, this.head, this.opts.pageRows!, this.opts.pageChars!)) {
      for (const e of page) {
        if (count > 0) {
          digest.update(COMMA);
          canonical(COMMA);
        }
        const bytes = encoder.encode(canonicalize(e));
        digest.update(bytes);
        canonical(bytes);
        await event?.(e, count === 0);
        count++;
        last = e;
      }
      this.opts.onPage?.({ pass, index: index++, rows: page.length });
    }
    assertPinnedHead(this.head, last, count, this.total_events, `pass ${pass}`);
    if (!digestsEqual(digest.digest(), this.eventsDigest)) throw new Error(`streaming export: pass ${pass} read different events from pass 0`);
  }
}

/** The snapshot's events (project, seq ≤ the pinned head), ascending, one page at a time. A row outside the window or
 *  out of order throws. */
async function* snapshotPages(source: ExportPageSource, project: string, head: ChainHead | null, rows: number, chars: number): AsyncGenerator<Event[]> {
  if (!head) return;
  if (!source.eventsPage) throw new Error("streaming export: the store has no eventsPage");
  let after = -1;
  while (after < head.seq) {
    const page = await source.eventsPage(project, after, head.seq, rows, chars);
    if (!page.length) return;
    for (const e of page) {
      if (e.project !== project || !(e.seq > after) || e.seq > head.seq) throw new Error(`streaming export: event #${e.seq} is outside the snapshot window or out of order`);
      after = e.seq;
    }
    yield page;
  }
}

function assertPinnedHead(head: ChainHead | null, last: Event | undefined, count: number, expected: number, pass: string): void {
  if (!head) {
    if (last) throw new Error(`streaming export: ${pass} read events from a project with no head`);
    return;
  }
  if (!last || last.seq !== head.seq || last.hash !== head.hash) throw new Error(`streaming export: ${pass} did not end at the pinned head #${head.seq}`);
  if (count !== expected) throw new Error(`streaming export: ${pass} read ${count} events, pass 0 read ${expected}`);
}
