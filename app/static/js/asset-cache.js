import { ASSET_PATHS, MAPROOM_UI, TERRAIN_TILE_ASSETS, TRIBE_CELL_ASSETS } from "./shared.js";
// Retry schedule for assets that fail to load (the proxy returns the odd 502
// under the burst of parallel requests preload() makes).
const ASSET_RETRY_BASE_MS = 500;
const ASSET_MAX_ATTEMPTS = 4;

export class AssetCache {
  constructor(config) {
    this.config = config;
    this.images = new Map();
  }

  async preload() {
    const assetList = new Set([
      ...Object.values(ASSET_PATHS),
      ...Object.values(TRIBE_CELL_ASSETS),
      ...TERRAIN_TILE_ASSETS,
      ...Object.values(MAPROOM_UI),
    ]);
    await Promise.all(
      [...assetList].map(async (path) => {
        const image = await this.loadImage(path);
        if (image) {
          this.images.set(path, image);
        } else {
          console.warn("[BYM-MR2] asset failed to preload, will retry:", path);
        }
      }),
    );
  }

  urlFor(path) {
    // Leading "/" marks a viewer-bundled asset served from our own origin.
    if (String(path).startsWith("/")) {
      return path;
    }
    // Game art routes through the viewer server's own /imagecache proxy
    // (disk-cached, upstream-fetching, bundled fallback - the same path
    // the base view already uses). Same-origin images keep every canvas
    // untainted, which is what lets the map EXPORT save detailed art;
    // direct CDN loads carried no CORS approval and poisoned toBlob().
    return `/imagecache/assets/${path}`;
  }

  /**
   * A preloaded image, or null.
   *
   * A miss also schedules a retry. preload() runs ~50 requests at once and the
   * proxy sometimes answers a few with 502; those used to resolve null and stay
   * null for the life of the page, which is why the map occasionally came up
   * without its terrain textures and had to be reloaded by hand. Callers
   * already handle null by falling back, so recovery just needs the retry.
   */
  get(path) {
    const image = this.images.get(path);
    if (image) {
      return image;
    }
    this.scheduleRetry(path);
    return null;
  }

  scheduleRetry(path) {
    this.retrying = this.retrying || new Set();
    this.failures = this.failures || new Map();
    const attempts = this.failures.get(path) || 0;
    if (this.retrying.has(path) || attempts >= ASSET_MAX_ATTEMPTS) {
      return;
    }
    this.retrying.add(path);
    // Backoff, so a genuinely missing asset cannot spin: 0.5s, 1s, 2s, 4s.
    const delay = ASSET_RETRY_BASE_MS * (2 ** attempts);
    setTimeout(async () => {
      const image = await this.loadImage(path);
      this.retrying.delete(path);
      if (image) {
        this.images.set(path, image);
        this.failures.delete(path);
        this.onAssetLoaded?.(path);
        return;
      }
      this.failures.set(path, attempts + 1);
      // Chain the next attempt rather than waiting for another get(): a
      // terrain tile is only requested while its band is on screen, so an
      // asset could otherwise sit failed until the user happened to pan.
      this.scheduleRetry(path);
    }, delay);
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


