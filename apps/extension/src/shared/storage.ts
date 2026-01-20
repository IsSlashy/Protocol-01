/**
 * Chrome Storage wrapper for Zustand persistence
 * Falls back to localStorage for development
 */

// Check if we're in an extension context with storage API available
const hasExtensionStorage = (): boolean => {
  try {
    return typeof chrome !== 'undefined' &&
           typeof chrome.storage !== 'undefined' &&
           typeof chrome.storage.local !== 'undefined';
  } catch {
    return false;
  }
};

export const chromeStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      if (hasExtensionStorage()) {
        const result = await chrome.storage.local.get(name);
        return result[name] ?? null;
      }
    } catch (e) {
      console.warn('Chrome storage not available, using localStorage', e);
    }
    return localStorage.getItem(name);
  },

  setItem: async (name: string, value: string): Promise<void> => {
    try {
      if (hasExtensionStorage()) {
        await chrome.storage.local.set({ [name]: value });
        return;
      }
    } catch (e) {
      console.warn('Chrome storage not available, using localStorage', e);
    }
    localStorage.setItem(name, value);
  },

  removeItem: async (name: string): Promise<void> => {
    try {
      if (hasExtensionStorage()) {
        await chrome.storage.local.remove(name);
        return;
      }
    } catch (e) {
      console.warn('Chrome storage not available, using localStorage', e);
    }
    localStorage.removeItem(name);
  },
};

/**
 * Secure storage for sensitive data (seed phrases, private keys)
 * Uses chrome.storage.session for ephemeral storage (cleared on browser close)
 */
const hasSessionStorage = (): boolean => {
  try {
    return typeof chrome !== 'undefined' &&
           typeof chrome.storage !== 'undefined' &&
           typeof chrome.storage.session !== 'undefined';
  } catch {
    return false;
  }
};

export const secureStorage = {
  get: async <T>(key: string): Promise<T | null> => {
    try {
      if (hasSessionStorage()) {
        const result = await chrome.storage.session.get(key);
        return result[key] ?? null;
      }
    } catch (e) {
      console.warn('Chrome session storage not available', e);
    }
    // Fallback for dev - NOT SECURE
    const value = sessionStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  },

  set: async <T>(key: string, value: T): Promise<void> => {
    try {
      if (hasSessionStorage()) {
        await chrome.storage.session.set({ [key]: value });
        return;
      }
    } catch (e) {
      console.warn('Chrome session storage not available', e);
    }
    sessionStorage.setItem(key, JSON.stringify(value));
  },

  remove: async (key: string): Promise<void> => {
    try {
      if (hasSessionStorage()) {
        await chrome.storage.session.remove(key);
        return;
      }
    } catch (e) {
      console.warn('Chrome session storage not available', e);
    }
    sessionStorage.removeItem(key);
  },

  clear: async (): Promise<void> => {
    try {
      if (hasSessionStorage()) {
        await chrome.storage.session.clear();
        return;
      }
    } catch (e) {
      console.warn('Chrome session storage not available', e);
    }
    sessionStorage.clear();
  },
};
