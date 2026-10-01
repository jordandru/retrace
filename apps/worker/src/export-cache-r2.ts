import { CachedExport, CachedExportMeta, ExportCacheStore, TornExportCacheError } from "@retrace-dev/core";

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

  async get(project: string): Promise<CachedExport | null> {
    const object = await this.bucket.get(this.key(project));
    if (!object) return null;
    return { ...this.metadata(project, object), bundle_json: await object.text() };
  }

  async meta(project: string): Promise<CachedExportMeta | null> {
    const object = await this.bucket.head(this.key(project));
    return object ? this.metadata(project, object) : null;
  }

  async put(entry: CachedExport): Promise<void> {
    const result = await this.bucket.put(this.key(entry.project), entry.bundle_json, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        format: FORMAT,
        project: entry.project,
        head_seq: String(entry.head_seq),
        head_hash: entry.head_hash,
        generated_at: entry.generated_at,
      },
    });
    if (!result) throw new Error(`R2 export cache put returned no object for project "${entry.project}"`);
  }

  async delete(project: string): Promise<boolean> {
    const existed = await this.bucket.head(this.key(project)) !== null;
    await this.bucket.delete(this.key(project));
    return existed;
  }
}
