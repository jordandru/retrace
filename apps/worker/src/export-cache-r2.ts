import { CachedExport, CachedExportMeta, CachedExportRead, ExportByteSink, ExportCacheStore, TornExportCacheError } from "@retrace-dev/core";

const FORMAT = "retrace-export-cache/1";
const PREFIX = "export-cache/v1/";

export class R2ExportCache implements ExportCacheStore {
  constructor(private bucket: R2Bucket) {}

  private key(project: string): string {
    return `${PREFIX}${encodeURIComponent(project)}.json`;
  }

  private metadata(project: string, object: Pick<R2Object, "customMetadata">): CachedExportMeta {
    const metadata = object.customMetadata;
    if (
      metadata?.format !== FORMAT ||
      metadata.project !== project ||
      !/^\d+$/.test(metadata.head_seq ?? "") ||
      !/^[0-9a-f]{64}$/.test(metadata.head_hash ?? "") ||
      !Number.isFinite(Date.parse(metadata.generated_at ?? ""))
    ) {
      throw new TornExportCacheError(project);
    }
    return {
      project,
      head_seq: Number(metadata.head_seq),
      head_hash: metadata.head_hash,
      generated_at: metadata.generated_at,
    };
  }

  /** The stored bytes as a stream, never read into memory (export-cache handoff §4f). The body passes through a
   *  FixedLengthStream of the object's size: workerd sends that length as the response's Content-Length. */
  async get(project: string): Promise<CachedExportRead | null> {
    const object = await this.bucket.get(this.key(project));
    if (!object) return null;
    let meta: CachedExportMeta;
    try {
      meta = this.metadata(project, object);
    } catch (error) {
      await object.body.cancel().catch(() => {});
      throw error;
    }
    return { ...meta, body: object.body.pipeThrough(new FixedLengthStream(object.size)), bytes: object.size };
  }

  async meta(project: string): Promise<CachedExportMeta | null> {
    const object = await this.bucket.head(this.key(project));
    return object ? this.metadata(project, object) : null;
  }

  private putOptions(entry: CachedExportMeta): R2PutOptions {
    return {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        format: FORMAT,
        project: entry.project,
        head_seq: String(entry.head_seq),
        head_hash: entry.head_hash,
        generated_at: entry.generated_at,
      },
    };
  }

  async put(entry: CachedExport): Promise<void> {
    const result = await this.bucket.put(this.key(entry.project), entry.bundle_json, this.putOptions(entry));
    if (!result) throw new Error(`R2 export cache put returned no object for project "${entry.project}"`);
  }

  /**
   * The new object streams in through a FixedLengthStream of exactly `bytes` (export-cache handoff §4e), with
   * backpressure. A throw from `write` aborts the stream, and so the put, and the old object stays; so does a short or
   * long write. R2 stores the object once `bytes` have arrived, abort or not, which is why the streamed export writes
   * its final bytes only after every check.
   */
  async putStream(entry: CachedExportMeta, bytes: number, write: (sink: ExportByteSink) => Promise<void>): Promise<void> {
    const { readable, writable } = new FixedLengthStream(bytes);
    const writer = writable.getWriter();
    const stored = this.bucket.put(this.key(entry.project), readable, this.putOptions(entry));
    stored.catch(() => {}); // observed below; never an unhandled rejection while `write` runs
    try {
      await write({
        write: async (chunk) => {
          await writer.ready;
          await writer.write(chunk);
        },
      });
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      await stored.catch(() => {});
      throw error;
    }
    if (!(await stored)) throw new Error(`R2 export cache put returned no object for project "${entry.project}"`);
  }

  async delete(project: string): Promise<boolean> {
    const existed = await this.bucket.head(this.key(project)) !== null;
    await this.bucket.delete(this.key(project));
    return existed;
  }
}
