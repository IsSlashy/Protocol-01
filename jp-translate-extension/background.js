/*
 * Background service worker.
 * - Proxies translation requests (Google Translate free endpoint, no key) so the
 *   content script never hits cross-origin CORS issues.
 * - Fetches & caches JPY -> USD/EUR exchange rates (frankfurter.app, free, no key).
 */

const RATE_TTL = 6 * 60 * 60 * 1000; // 6 hours
let rateCache = null; // { v: { usd, eur, asOf }, t: number }

async function getRates() {
  if (rateCache && Date.now() - rateCache.t < RATE_TTL) return rateCache.v;
  try {
    const res = await fetch(
      'https://api.frankfurter.app/latest?from=JPY&to=USD,EUR',
    );
    if (!res.ok) throw new Error('rates http ' + res.status);
    const data = await res.json();
    const v = {
      usd: data.rates && data.rates.USD,
      eur: data.rates && data.rates.EUR,
      asOf: data.date,
    };
    if (typeof v.usd !== 'number' || typeof v.eur !== 'number') {
      throw new Error('rates malformed');
    }
    rateCache = { v, t: Date.now() };
    return v;
  } catch (err) {
    // Fall back to stale cache if we have one; otherwise null.
    return rateCache ? rateCache.v : null;
  }
}

let loggedTranslateError = false;
async function translateOne(text, target) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    encodeURIComponent(target) +
    '&dt=t&q=' +
    encodeURIComponent(text);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    if (!loggedTranslateError) {
      loggedTranslateError = true;
      console.warn('[JP Translate BG] fetch error:', e && e.message);
    }
    throw e;
  }
  if (!res.ok) {
    if (!loggedTranslateError) {
      loggedTranslateError = true;
      console.warn('[JP Translate BG] translate HTTP', res.status);
    }
    throw new Error('translate http ' + res.status);
  }
  const data = await res.json();
  // data[0] is an array of [translatedSegment, originalSegment, ...]
  if (!Array.isArray(data) || !Array.isArray(data[0])) return text;
  return data[0].map((seg) => (seg && seg[0]) || '').join('');
}

async function translateMany(texts, target) {
  const out = new Array(texts.length);
  let cursor = 0;
  const CONCURRENCY = 8;

  async function worker() {
    while (cursor < texts.length) {
      const i = cursor++;
      try {
        out[i] = await translateOne(texts[i], target);
      } catch (err) {
        out[i] = texts[i]; // graceful fallback: keep original
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, texts.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'translate') {
    const texts = Array.isArray(msg.texts) ? msg.texts : [];
    const target = msg.target || 'en';
    console.log('[JP Translate BG] translate request:', texts.length, '->', target);
    translateMany(texts, target)
      .then((translations) => {
        const changed = translations.filter((t, i) => t !== texts[i]).length;
        console.log('[JP Translate BG] done:', changed, '/', texts.length, 'translated');
        sendResponse({ translations });
      })
      .catch((e) => {
        console.warn('[JP Translate BG] translate batch failed', e);
        sendResponse({ translations: texts });
      });
    return true; // async response
  }

  if (msg.type === 'rates') {
    getRates()
      .then((rates) => sendResponse({ rates }))
      .catch(() => sendResponse({ rates: null }));
    return true;
  }

  return false;
});
