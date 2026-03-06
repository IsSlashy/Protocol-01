// ============================================================================
// Client-Side zkSPL Prover — Lazy Circuit File Loader
// ============================================================================
//
// Downloads .wasm and .zkey files on demand, caches in memory after first load.
// Works in both browser (fetch) and Node.js (fs).
//
// The confidential_balance circuit is ~1,382 constraints, so circuit files
// are small enough to cache comfortably in memory.
//
// ============================================================================

import type {
  CircuitFileConfig,
  CircuitFiles,
  ProgressCallback,
  ProgressEvent,
} from './types';

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

const IS_NODE =
  typeof globalThis.process !== 'undefined' &&
  typeof globalThis.process.versions?.node === 'string';

// ---------------------------------------------------------------------------
// CircuitLoader
// ---------------------------------------------------------------------------

/**
 * Lazy loader and in-memory cache for circuit files.
 *
 * Loads .wasm and .zkey files from URLs (browser) or filesystem paths (Node).
 * Once loaded, files are cached so subsequent proof generations are instant.
 *
 * The loader is designed to work offline after the initial load —
 * once circuit files are cached, no network access is needed.
 */
export class CircuitLoader {
  /** Cached circuit file data, keyed by a caller-defined label */
  private cache = new Map<string, CircuitFiles>();

  /** In-flight loading promises to prevent duplicate concurrent loads */
  private loading = new Map<string, Promise<CircuitFiles>>();

  /**
   * Load circuit files for a given label. Returns cached data if already loaded.
   *
   * @param label - Cache key (e.g., 'balance' or 'sufficiency')
   * @param config - URLs or paths for the .wasm and .zkey files
   * @param onProgress - Optional progress callback for download tracking
   * @returns The loaded circuit files
   */
  async load(
    label: string,
    config: CircuitFileConfig,
    onProgress?: ProgressCallback,
  ): Promise<CircuitFiles> {
    // Return cached files immediately
    const cached = this.cache.get(label);
    if (cached) return cached;

    // If already loading, wait for the in-flight promise
    const inflight = this.loading.get(label);
    if (inflight) return inflight;

    // Start loading
    const promise = this.doLoad(label, config, onProgress);
    this.loading.set(label, promise);

    try {
      const files = await promise;
      this.cache.set(label, files);
      return files;
    } finally {
      this.loading.delete(label);
    }
  }

  /**
   * Check if circuit files are already cached.
   */
  isLoaded(label: string): boolean {
    return this.cache.has(label);
  }

  /**
   * Check if circuit files are currently being loaded.
   */
  isLoading(label: string): boolean {
    return this.loading.has(label);
  }

  /**
   * Preload circuit files in the background. Does not throw on failure —
   * returns a boolean indicating success.
   */
  async preload(
    label: string,
    config: CircuitFileConfig,
    onProgress?: ProgressCallback,
  ): Promise<boolean> {
    try {
      await this.load(label, config, onProgress);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear cached circuit files for a specific label, or all if no label given.
   * Useful for memory management in long-running sessions.
   */
  clear(label?: string): void {
    if (label) {
      this.cache.delete(label);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Get the cached circuit files without loading. Returns undefined if not cached.
   */
  getCached(label: string): CircuitFiles | undefined {
    return this.cache.get(label);
  }

  // -------------------------------------------------------------------------
  // Internal loading logic
  // -------------------------------------------------------------------------

  private async doLoad(
    label: string,
    config: CircuitFileConfig,
    onProgress?: ProgressCallback,
  ): Promise<CircuitFiles> {
    const circuitLabel = label as 'balance' | 'sufficiency';

    // Load WASM and zkey in parallel
    const [wasm, zkey] = await Promise.all([
      this.loadFile(config.wasmUrl, circuitLabel, 'wasm', onProgress),
      this.loadFile(config.zkeyUrl, circuitLabel, 'zkey', onProgress),
    ]);

    return { wasm, zkey };
  }

  private async loadFile(
    urlOrPath: string,
    circuit: 'balance' | 'sufficiency',
    file: 'wasm' | 'zkey',
    onProgress?: ProgressCallback,
  ): Promise<Uint8Array | string> {
    // In Node.js, if the path looks like a filesystem path, return it directly.
    // snarkjs can accept file paths in Node.
    if (IS_NODE && !urlOrPath.startsWith('http://') && !urlOrPath.startsWith('https://')) {
      return this.loadFromFilesystem(urlOrPath, circuit, file, onProgress);
    }

    // In browser or for HTTP URLs in Node, use fetch
    return this.loadFromNetwork(urlOrPath, circuit, file, onProgress);
  }

  private async loadFromNetwork(
    url: string,
    circuit: 'balance' | 'sufficiency',
    file: 'wasm' | 'zkey',
    onProgress?: ProgressCallback,
  ): Promise<Uint8Array> {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Failed to load circuit file from ${url}: HTTP ${response.status} ${response.statusText}`
      );
    }

    const contentLength = response.headers.get('Content-Length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    // If no progress callback or no body stream, do simple load
    if (!onProgress || !response.body) {
      const buffer = await response.arrayBuffer();
      onProgress?.({ circuit, file, loaded: buffer.byteLength, total: buffer.byteLength, done: true });
      return new Uint8Array(buffer);
    }

    // Stream with progress reporting
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      if (value) {
        chunks.push(value);
        loaded += value.length;
        onProgress({ circuit, file, loaded, total, done: false });
      }
    }

    // Merge chunks into a single Uint8Array
    const result = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    onProgress({ circuit, file, loaded, total: loaded, done: true });
    return result;
  }

  private async loadFromFilesystem(
    filePath: string,
    circuit: 'balance' | 'sufficiency',
    file: 'wasm' | 'zkey',
    onProgress?: ProgressCallback,
  ): Promise<Uint8Array | string> {
    // In Node.js, snarkjs can accept file paths directly for .zkey files
    // (which can be very large). For .wasm files it needs a Uint8Array or path.
    // We return the path string — snarkjs handles both.
    try {
      // Try to load as Uint8Array for consistent behavior
      const fs = await import('fs');
      const buffer = fs.readFileSync(filePath);
      const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      onProgress?.({ circuit, file, loaded: data.length, total: data.length, done: true });
      return data;
    } catch {
      // If fs read fails (e.g., path doesn't exist yet), return path string.
      // snarkjs will handle the path natively in Node.
      return filePath;
    }
  }
}
