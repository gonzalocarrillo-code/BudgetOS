import { Readable } from "node:stream";
import { Storage } from "@google-cloud/storage";

/**
 * Where uploads, rejected-rows reports and exports live (ADR-011, ADR-017). GCS in deployed
 * environments and against the emulator locally (GCS_EMULATOR_HOST); memory for the golden seed
 * and unit tests.
 */
export interface ObjectStore {
  read(uri: string): Readable;
  write(uri: string, body: string | Buffer, contentType: string): Promise<void>;
  exists(uri: string): Promise<boolean>;
  /** URL the browser sends a file to (with `uploadMethod`, PUT by default); expires after `ttlSeconds`. */
  uploadUrl(uri: string, contentType: string, ttlSeconds: number): Promise<string>;
  /** A signed GCS URL takes a PUT; the emulator's media upload takes a POST. */
  readonly uploadMethod?: "PUT" | "POST";
  /** URL the browser GETs the object from, saved as `filename`; expires after `ttlSeconds`. */
  downloadUrl(uri: string, filename: string, ttlSeconds: number): Promise<string>;
}

export function parseGsUri(uri: string): { bucket: string; path: string } {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m?.[1] || !m[2]) throw new Error(`not a gs:// uri: ${uri}`);
  return { bucket: m[1], path: m[2] };
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: string | Buffer; contentType: string }>();
  read(uri: string): Readable {
    const hit = this.objects.get(uri);
    if (!hit) throw new Error(`no object ${uri}`);
    return Readable.from([hit.body]);
  }
  async write(uri: string, body: string | Buffer, contentType: string): Promise<void> {
    this.objects.set(uri, { body, contentType });
  }
  async exists(uri: string): Promise<boolean> {
    return this.objects.has(uri);
  }
  async uploadUrl(uri: string): Promise<string> {
    return `memory://${parseGsUri(uri).bucket}/${parseGsUri(uri).path}`;
  }
  async downloadUrl(uri: string): Promise<string> {
    return `memory://${parseGsUri(uri).bucket}/${parseGsUri(uri).path}`;
  }
}

export class GcsObjectStore implements ObjectStore {
  private readonly emulator: string | undefined;
  private readonly storage: Storage;
  /**
   * With GCS_EMULATOR_HOST the client points at the emulator through `apiEndpoint`. The library's
   * own STORAGE_EMULATOR_HOST drops the `/storage/v1` prefix for bucket calls, so it is not used.
   */
  constructor(storage?: Storage, env: NodeJS.ProcessEnv = process.env) {
    this.emulator = env["GCS_EMULATOR_HOST"];
    this.storage = storage ?? (this.emulator ? new Storage({ apiEndpoint: this.emulator, projectId: "budget-os-local" }) : new Storage());
  }
  get uploadMethod(): "PUT" | "POST" {
    return this.emulator ? "POST" : "PUT";
  }
  private file(uri: string) {
    const { bucket, path } = parseGsUri(uri);
    return this.storage.bucket(bucket).file(path);
  }
  read(uri: string): Readable {
    return this.file(uri).createReadStream();
  }
  async write(uri: string, body: string | Buffer, contentType: string): Promise<void> {
    await this.file(uri).save(body, { contentType, resumable: false });
  }
  async exists(uri: string): Promise<boolean> {
    const [exists] = await this.file(uri).exists();
    return exists;
  }
  async uploadUrl(uri: string, contentType: string, ttlSeconds: number): Promise<string> {
    const { bucket, path } = parseGsUri(uri);
    // The emulator has no signing key; it accepts a plain media upload.
    if (this.emulator) return `${this.emulator}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(path)}`;
    const [url] = await this.file(uri).getSignedUrl({ version: "v4", action: "write", contentType, expires: Date.now() + ttlSeconds * 1000 });
    return url;
  }
  async downloadUrl(uri: string, filename: string, ttlSeconds: number): Promise<string> {
    const { bucket, path } = parseGsUri(uri);
    if (this.emulator) return `${this.emulator}/download/storage/v1/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;
    const [url] = await this.file(uri).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + ttlSeconds * 1000,
      responseDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
    });
    return url;
  }
}

/** GCS against the emulator or a GCP project; memory for local runs without either (like ADR-008's preview store). */
export function objectStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStore {
  return env["GCS_EMULATOR_HOST"] || env["GOOGLE_CLOUD_PROJECT"] ? new GcsObjectStore(undefined, env) : new MemoryObjectStore();
}

/** Bucket for CSV uploads, rejected-rows reports and exports. */
export const uploadBucket = (env: NodeJS.ProcessEnv = process.env): string => env["UPLOAD_BUCKET"] ?? "budget-os-uploads";
