/*
 * Content script: translates Japanese text in place and appends USD/EUR next to
 * JPY prices. Driven entirely by chrome.storage (one ON/OFF switch in the popup).
 * Reverts cleanly when turned off.
 */
(() => {
  // Guard against double-injection (manifest content script + popup scripting).
  if (window.__jpTranslateLoaded) return;
  window.__jpTranslateLoaded = true;

  // Japanese: Hiragana, Katakana, CJK ideographs, half-width katakana.
  const JP_RE =
    /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;
  // Quick test for a JPY price in the *original* text.
  const PRICE_TEST = /[¥￥]|円|JPY|[0-9０-９][\s,，]*yen/i;
  // Matches a JPY amount in any (original or translated) text.
  const PRICE_RE =
    /(?:[¥￥]\s?[0-9０-９][0-9０-９.,，]*\s?[万千]?|JPY\s?[0-9０-９][0-9０-９.,，]*\s?[万千]?|[0-9０-９][0-9０-９.,，]*\s?[万千]?\s?(?:円|yen|JPY))/gi;

  // NB: OPTION/SELECT are intentionally NOT skipped — translating an option's
  // display text is safe (its `value` attribute is untouched) and useful for
  // sort/filter dropdowns. INPUT/TEXTAREA stay skipped (editable values).
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT',
    'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'CANVAS', 'MATH',
  ]);

  let enabled = false;
  let settings = { target: 'en', currency: 'both' };
  let rates = null; // { usd, eur } per 1 JPY
  let observer = null;
  let scheduled = null;
  const pending = [];

  let processed = new WeakSet(); // text nodes already handled
  let original = new Map(); // Text node -> first original value (for revert)
  const cache = new Map(); // trimmed JP text -> translation
  const lastSet = new WeakMap(); // Text node -> value we last wrote (loop guard)
  let translatedCount = 0;

  // ---- diagnostics --------------------------------------------------------

  const DEBUG = true;
  const log = (...a) => {
    if (DEBUG) console.log('[JP Translate]', ...a);
  };

  let toastEl = null;
  let toastTimer = null;
  function toast(msg, sticky) {
    try {
      if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement('div');
        toastEl.id = '__jp-translate-toast';
        toastEl.setAttribute('translate', 'no');
        toastEl.style.cssText =
          'position:fixed;z-index:2147483647;right:14px;bottom:14px;' +
          'background:#0e1116;color:#e6edf3;font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;' +
          'padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);' +
          'box-shadow:0 6px 24px rgba(0,0,0,.45);pointer-events:none;opacity:0;transition:opacity .2s;';
        (document.documentElement || document.body).appendChild(toastEl);
      }
      toastEl.textContent = 'JP Translate · ' + msg;
      toastEl.style.opacity = '1';
      if (toastTimer) clearTimeout(toastTimer);
      if (!sticky) {
        toastTimer = setTimeout(() => {
          if (toastEl) toastEl.style.opacity = '0';
        }, 2500);
      }
    } catch (e) {
      /* noop */
    }
  }

  log('content script loaded on', location.href);

  // ---- helpers ------------------------------------------------------------

  const toAsciiDigits = (s) =>
    s
      .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
      .replace(/[，]/g, ',');

  function fmtMoney(n) {
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (n >= 100) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function convertJpy(jpy) {
    if (!rates) return '';
    const parts = [];
    if (settings.currency !== 'eur' && typeof rates.usd === 'number') {
      parts.push('$' + fmtMoney(jpy * rates.usd));
    }
    if (settings.currency !== 'usd' && typeof rates.eur === 'number') {
      parts.push('€' + fmtMoney(jpy * rates.eur));
    }
    return parts.length ? '≈ ' + parts.join(' / ') : '';
  }

  // Compute conversions from the ORIGINAL text (where ¥ / 円 / JPY are reliable),
  // so we don't depend on how Google renders 円 (sometimes "yen", sometimes
  // "circle"/"round"). Returns one "≈ $X / €Y" string per JPY amount found.
  function parseJpy(token) {
    const num = parseFloat(toAsciiDigits(token).replace(/[^\d.]/g, ''));
    if (!num || isNaN(num)) return 0;
    if (/万/.test(token)) return Math.round(num * 10000);
    if (/千/.test(token)) return Math.round(num * 1000);
    return Math.round(num);
  }

  function extractConversions(text) {
    if (!rates) return [];
    const out = [];
    for (const m of text.matchAll(PRICE_RE)) {
      const jpy = parseJpy(m[0]);
      if (jpy >= 1) {
        const conv = convertJpy(jpy);
        if (conv) out.push(conv);
      }
    }
    return out;
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          // swallow "context invalidated" etc.
          void chrome.runtime.lastError;
          resolve(resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // ---- DOM walking --------------------------------------------------------

  function shouldSkipParent(node) {
    const parent = node.parentNode;
    if (!parent || parent.nodeType !== 1) return true;
    if (SKIP_TAGS.has(parent.nodeName)) return true;
    if (parent.isContentEditable) return true;
    // We deliberately do NOT honour translate="no" / .notranslate: sites mark
    // brand terms (e.g. 楽天トラベル, ログイン) with it, but this extension is
    // explicitly a "translate everything" tool for reading JP pages.
    return false;
  }

  function collectTextNodes(root, into) {
    if (root.nodeType === 3) {
      into.push(root);
      return;
    }
    if (root.nodeType !== 1) return;
    if (SKIP_TAGS.has(root.nodeName)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (shouldSkipParent(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) into.push(n);
  }

  // ---- core processing ----------------------------------------------------

  async function processNodes(nodes) {
    if (!enabled) return;

    const items = [];
    const needKeys = new Set();

    for (const node of nodes) {
      if (processed.has(node)) continue;
      const raw = node.nodeValue;
      if (!raw || !raw.trim()) continue;
      if (shouldSkipParent(node)) continue;

      const isJP = JP_RE.test(raw);
      const hasPrice = PRICE_TEST.test(raw);
      if (!isJP && !hasPrice) {
        processed.add(node); // nothing to do, never look again
        continue;
      }
      items.push({ node, raw, isJP });
      if (isJP) {
        const key = raw.trim();
        if (!cache.has(key)) needKeys.add(key);
      }
    }

    if (needKeys.size) {
      const keys = [...needKeys];
      log('requesting translation of', keys.length, 'strings ->', settings.target);
      const resp = await sendMessage({
        type: 'translate',
        texts: keys,
        target: settings.target,
      });
      const translations = (resp && resp.translations) || keys;
      const unchanged = keys.filter((k, i) => translations[i] === k).length;
      log('translation reply:', translations.length, 'items,', unchanged, 'unchanged');
      if (resp == null) {
        toast('⚠ pas de réponse du service worker', true);
      } else if (keys.length > 0 && unchanged === keys.length) {
        toast('⚠ traduction indisponible (API bloquée ?)', true);
      }
      keys.forEach((k, i) => cache.set(k, translations[i] || k));
      if (!enabled) return; // turned off mid-flight
    }

    let changed = 0;
    for (const { node, raw, isJP } of items) {
      if (!node.isConnected) continue;
      if (!original.has(node)) original.set(node, raw);

      let out = raw;
      if (isJP) {
        const key = raw.trim();
        const translated = cache.get(key) || raw;
        const lead = (raw.match(/^\s*/) || [''])[0];
        const trail = (raw.match(/\s*$/) || [''])[0];
        out = lead + translated + trail;
      }
      // Append USD/EUR for every JPY amount detected in the ORIGINAL text.
      const convs = extractConversions(raw);
      if (convs.length) {
        out = out + ' ' + convs.map((c) => '(' + c + ')').join(' ');
      }

      if (out !== node.nodeValue) {
        node.nodeValue = out;
        lastSet.set(node, out);
        changed++;
      }
      processed.add(node);
    }
    if (changed > 0) {
      translatedCount += changed;
      toast('✓ ' + translatedCount + ' éléments traduits');
      log('applied', changed, 'changes (total', translatedCount + ')');
    }
  }

  function schedule(nodes) {
    for (const n of nodes) pending.push(n);
    if (scheduled) return;
    const run = () => {
      scheduled = null;
      if (!enabled) {
        pending.length = 0;
        return;
      }
      const batch = pending.splice(0, pending.length);
      processNodes(batch);
    };
    scheduled =
      'requestIdleCallback' in window
        ? requestIdleCallback(run, { timeout: 800 })
        : setTimeout(run, 200);
  }

  // ---- enable / disable ---------------------------------------------------

  async function start() {
   try {
    log('start() — fetching rates…');
    toast('ON — traduction…', true);
    if (!rates) {
      const resp = await sendMessage({ type: 'rates' });
      rates = (resp && resp.rates) || null;
      log('rates =', rates);
    }
    const nodes = [];
    collectTextNodes(document.body || document.documentElement, nodes);
    log('collected', nodes.length, 'candidate text nodes');
    if (nodes.length === 0) toast('⚠ aucun texte trouvé', true);
    schedule(nodes);

    if (!observer) {
      observer = new MutationObserver((mutations) => {
        if (!enabled) return;
        const fresh = [];
        for (const m of mutations) {
          if (m.type === 'childList') {
            m.addedNodes.forEach((n) => collectTextNodes(n, fresh));
          } else if (m.type === 'characterData') {
            const t = m.target;
            if (
              t &&
              t.nodeType === 3 &&
              t.nodeValue !== lastSet.get(t) &&
              !shouldSkipParent(t)
            ) {
              processed.delete(t); // changed by the site -> re-translate
              original.delete(t);
              fresh.push(t);
            }
          }
        }
        if (fresh.length) schedule(fresh);
      });
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Safety net: re-scan a couple of times for late-loading content
    // (personalized widgets, carousels) that mutation events can miss.
    for (const delay of [1500, 4000]) {
      setTimeout(() => {
        if (!enabled) return;
        const more = [];
        collectTextNodes(document.body || document.documentElement, more);
        schedule(more);
      }, delay);
    }
   } catch (e) {
    log('start() error', e);
    toast('erreur: ' + (e && e.message), true);
   }
  }

  function stop() {
    if (observer) observer.disconnect();
    if (scheduled) {
      if ('cancelIdleCallback' in window && typeof scheduled === 'number') {
        try { cancelIdleCallback(scheduled); } catch (e) { /* noop */ }
      }
      clearTimeout(scheduled);
      scheduled = null;
    }
    pending.length = 0;

    // Revert every node we touched.
    for (const [node, value] of original) {
      if (node.isConnected) node.nodeValue = value;
    }
    original = new Map();
    processed = new WeakSet();
  }

  function applyEnabled(next) {
    if (next === enabled) return;
    enabled = next;
    if (enabled) start();
    else stop();
  }

  // Re-run from scratch (target/currency changed while ON).
  function refresh() {
    if (!enabled) return;
    stop();
    cache.clear(); // target may have changed -> translations invalid
    enabled = true;
    start();
  }

  // ---- wiring -------------------------------------------------------------

  chrome.storage.local.get(
    { enabled: false, target: 'en', currency: 'both' },
    (s) => {
      settings = { target: s.target, currency: s.currency };
      log('initial state', s);
      if (s.enabled) applyEnabled(true);
    },
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    log('storage changed', changes);
    let settingsChanged = false;
    if (changes.target) {
      settings.target = changes.target.newValue;
      settingsChanged = true;
    }
    if (changes.currency) {
      settings.currency = changes.currency.newValue;
      settingsChanged = true;
    }
    if (changes.enabled) {
      applyEnabled(!!changes.enabled.newValue);
    } else if (settingsChanged && enabled) {
      refresh();
    }
  });
})();
