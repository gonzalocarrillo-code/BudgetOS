export const ASSET_STORE = Symbol("ASSET_STORE");

export interface StoredAsset {
  body: Uint8Array;
  contentType: string;
}

/** Object store used by POST /assets. Local tests and the API process keep bytes in memory. */
export interface AssetStore {
  put(objectKey: string, body: Uint8Array, contentType: string): Promise<void>;
  get(objectKey: string): StoredAsset | undefined;
  has(objectKey: string): boolean;
  signedUrl(objectKey: string): string;
}

export class InMemoryAssetStore implements AssetStore {
  private readonly objects = new Map<string, StoredAsset>();

  async put(objectKey: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(objectKey, { body, contentType });
  }

  get(objectKey: string): StoredAsset | undefined {
    return this.objects.get(objectKey);
  }

  has(objectKey: string): boolean {
    return this.objects.has(objectKey);
  }

  signedUrl(objectKey: string): string {
    return `memory://${objectKey}`;
  }
}
