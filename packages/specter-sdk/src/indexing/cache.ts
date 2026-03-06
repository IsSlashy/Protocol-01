/**
 * Indexer Cache — pluggable storage backends for client-side indexing
 *
 * Provides a simple key-value cache interface with default implementations
 * for in-memory (works everywhere) and localStorage (browser/extension).
 * Users can supply their own cache (e.g., AsyncStorage for React Native).
 */

// ============================================================================
// Cache Interface
// ============================================================================

/**
 * Synchronous cache interface for indexer persistence.
 * All values are stored as strings (JSON-serialized by the caller).
 */
export interface IndexerCache {
  /** Retrieve a value by key. Returns null if not found. */
  get(key: string): string | null;

  /** Store a value under the given key. */
  set(key: string, value: string): void;

  /** Remove a single key. */
  delete(key: string): void;

  /** Remove all keys managed by this cache instance. */
  clear(): void;
}

// ============================================================================
// MemoryCache — works everywhere (Node, browser, React Native)
// ============================================================================

/**
 * In-memory cache backed by a plain Map.
 * Data is lost when the process exits; useful for short-lived sessions or
 * as a fallback when no persistent storage is available.
 */
export class MemoryCache implements IndexerCache {
  private store: Map<string, string> = new Map();

  get(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

// ============================================================================
// LocalStorageCache — browser & extension environments
// ============================================================================

/**
 * Persistent cache backed by `window.localStorage`.
 * All keys are prefixed with a namespace to avoid collisions.
 *
 * Falls back to MemoryCache silently when localStorage is unavailable
 * (e.g., SSR, privacy-restricted iframes).
 */
export class LocalStorageCache implements IndexerCache {
  private prefix: string;
  private fallback: MemoryCache | null = null;

  constructor(namespace: string = 'specter_idx') {
    this.prefix = namespace + ':';

    // Detect if localStorage is actually usable
    if (!LocalStorageCache.isAvailable()) {
      this.fallback = new MemoryCache();
    }
  }

  get(key: string): string | null {
    if (this.fallback) return this.fallback.get(key);
    try {
      return localStorage.getItem(this.prefix + key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    if (this.fallback) {
      this.fallback.set(key, value);
      return;
    }
    try {
      localStorage.setItem(this.prefix + key, value);
    } catch {
      // Storage full or blocked — silently swallow
    }
  }

  delete(key: string): void {
    if (this.fallback) {
      this.fallback.delete(key);
      return;
    }
    try {
      localStorage.removeItem(this.prefix + key);
    } catch {
      // Ignore
    }
  }

  clear(): void {
    if (this.fallback) {
      this.fallback.clear();
      return;
    }
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(this.prefix)) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        localStorage.removeItem(k);
      }
    } catch {
      // Ignore
    }
  }

  /** Check whether localStorage is usable in this environment. */
  private static isAvailable(): boolean {
    try {
      const testKey = '__specter_ls_test__';
      localStorage.setItem(testKey, '1');
      localStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }
}
