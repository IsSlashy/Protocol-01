"use strict";
(() => {
  // src/inject/index.ts
  var CHANNEL = "p01-extension-channel";
  var REQUEST_TIMEOUT = 3e5;
  function generateUUID() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = bytes[6] & 15 | 64;
      bytes[8] = bytes[8] & 63 | 128;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : r & 3 | 8;
      return v.toString(16);
    });
  }
  var pendingRequests = /* @__PURE__ */ new Map();
  var approvalToOriginal = /* @__PURE__ */ new Map();
  var eventListeners = /* @__PURE__ */ new Map();
  function addEventListener(event, callback) {
    if (!eventListeners.has(event)) {
      eventListeners.set(event, /* @__PURE__ */ new Set());
    }
    eventListeners.get(event).add(callback);
  }
  function removeEventListener(event, callback) {
    eventListeners.get(event)?.delete(callback);
  }
  function emit(event, ...args) {
    eventListeners.get(event)?.forEach((cb) => {
      try {
        cb(...args);
      } catch (error) {
        console.error(`Error in ${event} event handler:`, error);
      }
    });
  }
  function sendMessage(type, payload) {
    return new Promise((resolve, reject) => {
      const requestId = generateUUID();
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error("Request timeout - user may have closed the approval window"));
      }, REQUEST_TIMEOUT);
      pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout
      });
      window.postMessage({
        source: "p01-inject",
        channel: CHANNEL,
        type,
        payload,
        requestId
      }, "*");
    });
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "p01-content") return;
    if (event.data?.channel !== CHANNEL) return;
    const { type, payload, requestId, error } = event.data;
    if (type === "APPROVAL_RESULT") {
      const originalRequestId = approvalToOriginal.get(requestId) || requestId;
      const pending = pendingRequests.get(originalRequestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(originalRequestId);
        approvalToOriginal.delete(requestId);
        if (payload?.approved) {
          pending.resolve(payload.data || { success: true });
        } else {
          pending.reject(new Error(payload?.reason || "User rejected the request"));
        }
      }
      return;
    }
    if (type.endsWith("_RESPONSE")) {
      const pending = pendingRequests.get(requestId);
      if (pending) {
        if (payload?.pending && payload?.requestId) {
          approvalToOriginal.set(payload.requestId, requestId);
          console.log("[Protocol 01] Waiting for approval:", payload.requestId);
          return;
        }
        clearTimeout(pending.timeout);
        pendingRequests.delete(requestId);
        if (error || payload?.error) {
          pending.reject(new Error(error || payload?.error));
        } else {
          pending.resolve(payload);
        }
      }
    }
    if (type === "ACCOUNT_CHANGED") {
      const newPublicKey = payload?.publicKey ? createPublicKey(payload.publicKey) : null;
      provider._publicKey = newPublicKey;
      emit("accountChanged", newPublicKey);
    }
    if (type === "DISCONNECT") {
      provider._publicKey = null;
      provider._isConnected = false;
      emit("disconnect");
    }
  });
  function createPublicKey(address) {
    const bytes = base58Decode(address);
    return {
      toString: () => address,
      toBase58: () => address,
      toBytes: () => bytes,
      equals: (other) => address === other.toBase58()
    };
  }
  function base58Decode(str) {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const ALPHABET_MAP = {};
    for (let i = 0; i < ALPHABET.length; i++) {
      ALPHABET_MAP[ALPHABET[i]] = i;
    }
    let bytes = [0];
    for (const char of str) {
      const value = ALPHABET_MAP[char];
      if (value === void 0) throw new Error("Invalid base58 character");
      let carry = value;
      for (let i = 0; i < bytes.length; i++) {
        carry += bytes[i] * 58;
        bytes[i] = carry & 255;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 255);
        carry >>= 8;
      }
    }
    for (const char of str) {
      if (char === "1") bytes.push(0);
      else break;
    }
    return new Uint8Array(bytes.reverse());
  }
  function base58Encode(bytes) {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let num = BigInt(0);
    for (const byte of bytes) {
      num = num * BigInt(256) + BigInt(byte);
    }
    let result = "";
    while (num > 0) {
      result = ALPHABET[Number(num % BigInt(58))] + result;
      num = num / BigInt(58);
    }
    for (const byte of bytes) {
      if (byte === 0) result = "1" + result;
      else break;
    }
    return result || "1";
  }
  function uint8ArrayToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  var provider = {
    // ============ Properties ============
    isProtocol01: true,
    isPhantom: false,
    // Don't spoof Phantom
    isSolflare: false,
    // Don't spoof Solflare
    _isConnected: false,
    _publicKey: null,
    get isConnected() {
      return this._isConnected;
    },
    get publicKey() {
      return this._publicKey;
    },
    // ============ Connection Methods ============
    /**
     * Connect to the wallet
     * Opens approval popup if not already connected
     */
    async connect(options) {
      if (options?.onlyIfTrusted) {
        const result2 = await sendMessage(
          "CONNECT_SILENT"
        );
        if (!result2.connected || !result2.publicKey) {
          throw new Error("User has not approved this app");
        }
        this._publicKey = createPublicKey(result2.publicKey);
        this._isConnected = true;
        emit("connect", { publicKey: this._publicKey });
        return { publicKey: this._publicKey };
      }
      const result = await sendMessage("CONNECT", {
        origin: window.location.origin,
        title: document.title,
        icon: getFavicon()
      });
      if (!result.publicKey) {
        throw new Error("Failed to connect");
      }
      this._publicKey = createPublicKey(result.publicKey);
      this._isConnected = true;
      emit("connect", { publicKey: this._publicKey });
      return { publicKey: this._publicKey };
    },
    /**
     * Disconnect from the wallet
     */
    async disconnect() {
      await sendMessage("DISCONNECT", {
        origin: window.location.origin
      });
      this._publicKey = null;
      this._isConnected = false;
      emit("disconnect");
    },
    // ============ Signing Methods ============
    /**
     * Sign a message
     * @param message - The message to sign (Uint8Array)
     * @param display - Optional display format ('utf8' or 'hex')
     */
    async signMessage(message, display) {
      if (!this._isConnected || !this._publicKey) {
        throw new Error("Wallet not connected");
      }
      const messageBase64 = uint8ArrayToBase64(message);
      let displayText;
      if (display === "utf8") {
        displayText = new TextDecoder().decode(message);
      } else if (display === "hex") {
        displayText = Array.from(message).map((b) => b.toString(16).padStart(2, "0")).join("");
      } else {
        try {
          displayText = new TextDecoder("utf-8", { fatal: true }).decode(message);
        } catch {
          displayText = Array.from(message).map((b) => b.toString(16).padStart(2, "0")).join("");
        }
      }
      const result = await sendMessage("SIGN_MESSAGE", {
        origin: window.location.origin,
        message: messageBase64,
        displayText
      });
      return {
        signature: base64ToUint8Array(result.signature),
        publicKey: this._publicKey
      };
    },
    /**
     * Sign a transaction
     * @param transaction - The transaction to sign
     */
    async signTransaction(transaction) {
      if (!this._isConnected || !this._publicKey) {
        throw new Error("Wallet not connected");
      }
      const serialized = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      });
      const transactionBase64 = uint8ArrayToBase64(serialized);
      const result = await sendMessage("SIGN_TRANSACTION", {
        origin: window.location.origin,
        transaction: transactionBase64
      });
      const signedBytes = base64ToUint8Array(result.signedTransaction);
      transaction._signedBytes = signedBytes;
      return transaction;
    },
    /**
     * Sign multiple transactions
     * @param transactions - Array of transactions to sign
     */
    async signAllTransactions(transactions) {
      if (!this._isConnected || !this._publicKey) {
        throw new Error("Wallet not connected");
      }
      const serializedTransactions = transactions.map((tx) => {
        const serialized = tx.serialize({
          requireAllSignatures: false,
          verifySignatures: false
        });
        return uint8ArrayToBase64(serialized);
      });
      const result = await sendMessage(
        "SIGN_ALL_TRANSACTIONS",
        {
          origin: window.location.origin,
          transactions: serializedTransactions
        }
      );
      return transactions.map((tx, i) => {
        const signedBytes = base64ToUint8Array(result.signedTransactions[i]);
        tx._signedBytes = signedBytes;
        return tx;
      });
    },
    /**
     * Sign and send a transaction
     * @param transaction - The transaction to sign and send
     * @param options - Send options
     */
    async signAndSendTransaction(transaction, options) {
      if (!this._isConnected || !this._publicKey) {
        throw new Error("Wallet not connected");
      }
      const serialized = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      });
      const transactionBase64 = uint8ArrayToBase64(serialized);
      const result = await sendMessage("SIGN_AND_SEND_TRANSACTION", {
        origin: window.location.origin,
        transaction: transactionBase64,
        options
      });
      return {
        signature: result.signature,
        publicKey: this._publicKey
      };
    },
    // ============ Event Methods ============
    /**
     * Add event listener
     */
    on(event, callback) {
      addEventListener(event, callback);
    },
    /**
     * Remove event listener
     */
    off(event, callback) {
      removeEventListener(event, callback);
    },
    /**
     * Add event listener (alias for on)
     */
    addListener(event, callback) {
      addEventListener(event, callback);
    },
    /**
     * Remove event listener (alias for off)
     */
    removeListener(event, callback) {
      removeEventListener(event, callback);
    },
    // ============ Protocol 01 Specific Methods ============
    /**
     * Send a private transaction using stealth addresses
     */
    async sendPrivate(options) {
      if (!this._isConnected) {
        throw new Error("Wallet not connected");
      }
      return sendMessage("SEND_PRIVATE", {
        origin: window.location.origin,
        ...options
      });
    },
    /**
     * Generate a stealth address for private receiving
     */
    async generateStealthAddress() {
      if (!this._isConnected) {
        throw new Error("Wallet not connected");
      }
      return sendMessage(
        "GENERATE_STEALTH_ADDRESS",
        { origin: window.location.origin }
      );
    },
    /**
     * Create a subscription (Stream Secure)
     */
    async subscribe(options) {
      if (!this._isConnected) {
        throw new Error("Wallet not connected");
      }
      return sendMessage("CREATE_SUBSCRIPTION", {
        origin: window.location.origin,
        ...options,
        maxPeriods: options.maxPeriods ?? 0
      });
    },
    /**
     * Get active subscriptions
     */
    async getSubscriptions() {
      return sendMessage("GET_SUBSCRIPTIONS", {
        origin: window.location.origin
      }).then((r) => r.subscriptions);
    },
    /**
     * Cancel a subscription
     */
    async cancelSubscription(subscriptionId) {
      return sendMessage("CANCEL_SUBSCRIPTION", {
        origin: window.location.origin,
        subscriptionId
      });
    }
  };
  function getFavicon() {
    const link = document.querySelector("link[rel*='icon']") || document.querySelector("link[rel='shortcut icon']");
    return link?.href || void 0;
  }
  function injectProvider() {
    if (typeof window.protocol01 === "undefined") {
      Object.defineProperty(window, "protocol01", {
        value: provider,
        writable: false,
        configurable: false
      });
    }
    if (typeof window.solana === "undefined") {
      Object.defineProperty(window, "solana", {
        value: provider,
        writable: false,
        configurable: false
      });
    }
    window.dispatchEvent(new CustomEvent("protocol01#initialized"));
    try {
      const event = new CustomEvent("wallet-standard:register", {
        detail: {
          register: (callback) => {
            callback({
              name: "Protocol 01",
              icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIGZpbGw9IiMwMEZGRkYiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZG9taW5hbnQtYmFzZWxpbmU9Im1pZGRsZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iIzAwMCIgZm9udC1zaXplPSIxMiIgZm9udC1mYW1pbHk9Im1vbm9zcGFjZSI+MDE8L3RleHQ+PC9zdmc+",
              chains: ["solana:mainnet", "solana:devnet", "solana:testnet"],
              features: {
                "standard:connect": { connect: provider.connect.bind(provider) },
                "standard:disconnect": { disconnect: provider.disconnect.bind(provider) },
                "solana:signTransaction": {
                  signTransaction: provider.signTransaction.bind(provider)
                },
                "solana:signMessage": { signMessage: provider.signMessage.bind(provider) }
              },
              accounts: []
            });
          }
        }
      });
      window.dispatchEvent(event);
    } catch (e) {
    }
    console.log("[Protocol 01] Wallet provider injected");
  }
  if (window.location.protocol === "https:" || window.location.protocol === "http:") {
    injectProvider();
  }
})();
