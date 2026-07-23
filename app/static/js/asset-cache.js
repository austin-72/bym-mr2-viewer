import { ASSET_PATHS, TRIBE_CELL_ASSETS } from "./shared.js";
export class AssetCache {
  constructor(config) {
    this.config = config;
    this.images = new Map();
  }

  async preload() {
    const assetList = new Set([...Object.values(ASSET_PATHS), ...Object.values(TRIBE_CELL_ASSETS)]);
    await Promise.all(
      [...assetList].map(async (path) => {
        const image = await this.loadImage(path);
        if (image) {
          this.images.set(path, image);
        }
      }),
    );
  }

  urlFor(path) {
    // Leading "/" marks a viewer-bundled asset served from our own origin.
    if (String(path).startsWith("/")) {
      return path;
    }
    return `${this.config.cdnBaseUrl}/assets/${path}`;
  }

  get(path) {
    return this.images.get(path) || null;
  }

  async loadImage(path) {
    return new Promise((resolve) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = this.urlFor(path);
    });
  }

}


