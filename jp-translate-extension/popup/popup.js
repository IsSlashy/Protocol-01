/* Popup: one ON/OFF switch + target language / currency. Persists to storage;
 * the content scripts react to storage changes on every page. */

const DEFAULTS = { enabled: false, target: 'en', currency: 'both' };

const powerBtn = document.getElementById('power');
const powerText = powerBtn.querySelector('.power-text');
const statusEl = document.getElementById('status');
const targetSel = document.getElementById('target');
const currencySel = document.getElementById('currency');

function render(state) {
  const on = !!state.enabled;
  powerBtn.classList.toggle('on', on);
  powerBtn.setAttribute('aria-checked', String(on));
  powerText.textContent = on ? 'ON' : 'OFF';
  statusEl.textContent = on ? 'Traduction active sur cette page' : 'Désactivé';
  targetSel.value = state.target;
  currencySel.value = state.currency;
}

// Ensure the content script is live in the current tab, even if the tab was
// opened before the extension was installed/enabled.
async function ensureInjected() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return false;
    const url = tab.url || tab.pendingUrl || '';
    // Only browser-internal pages can't be injected; everything else (incl. when
    // the URL isn't readable) we attempt and let executeScript decide.
    if (/^(chrome|edge|opera|about|chrome-extension|moz-extension|devtools|view-source):/.test(url)) {
      return false;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    return true;
  } catch (e) {
    console.warn('[JP Translate] injection failed:', e && e.message);
    return false;
  }
}

chrome.storage.local.get(DEFAULTS, (state) => render(state));

powerBtn.addEventListener('click', async () => {
  const { enabled } = await chrome.storage.local.get({ enabled: false });
  const next = !enabled;
  if (next) await ensureInjected();
  await chrome.storage.local.set({ enabled: next });
  const state = await chrome.storage.local.get(DEFAULTS);
  render(state);
});

targetSel.addEventListener('change', () => {
  chrome.storage.local.set({ target: targetSel.value });
});

currencySel.addEventListener('change', () => {
  chrome.storage.local.set({ currency: currencySel.value });
});
