"use client";

import { memo } from "react";
import { useT } from "@/i18n";

/**
 * The Observer Test, in the Styx voice.
 *
 * A local restyle of components/explorer/ObserverTest.tsx. That file is shared
 * territory and is left byte-for-byte untouched; it simply stops being imported
 * here.
 *
 * WHAT THIS MODULE MAY SAY, AND WHY IT NOW SAYS LESS.
 *
 * The pre-port module, and the first port after it, sealed From, To and Amount
 * on the right-hand column. That asserts a Styx payment publishes none of the
 * three. Two of those are untrue today:
 *
 *  - From. The payer's own wallet signs and pays for the transaction, on the
 *    stealth leg and on the pool leg alike, and a withdrawal republishes the
 *    commitment of the deposit it spends, so the payer stays reachable from the
 *    chain. The sender is not hidden. The row therefore prints the same account
 *    on both sides, because that is what an observer reads on both sides.
 *  - Amount. The pools are denominated: the pool a note sits in IS the amount,
 *    and the pool is public. Same value on both sides for the same reason.
 *  - To. This one is real, and it is the only field the protocol changes today:
 *    the payee is a fresh one-time stealth address, not their reusable wallet.
 *
 * So the columns now differ where the protocol really differs, the payee and
 * the absent memo, plus the proof the chain verifies. Nothing is sealed that is
 * not actually missing from the transaction.
 *
 * i18n. Every label is a t() call on the same explorer.observer.* keys as
 * before, and so is the footnote under the grid. The VALUES
 * are locale-neutral by construction: accounts, an amount, a circuit name, and
 * a block-glyph redaction for the one field that carries nothing. The pre-port
 * module printed those glyphs as well. An English sentence in a value slot
 * reads as English to a French visitor, which is why there are none.
 *
 * The reveal toggle is gone rather than restyled. Its two labels were
 * explorer.observer.toggleShow and explorer.observer.toggleHide, and the second
 * is "Hide like Protocol 01" in English and "Masquer comme Protocol 01" in
 * French: the retired brand, in both locales. Worse, the state it produced
 * sealed From and Amount on the standard column, which is the same untrue claim
 * as above with a button on it. There is nothing left for the control to toggle
 * now that both columns print what an observer really reads, so it is the render
 * that goes, and the replacement wording for the two keys is reported upward.
 *
 * The footnote under the grid IS rendered, on explorer.observer.footnote, the
 * key that belongs in the slot. Its current sentence, "We cannot, by design.
 * Only the proof is public.", is false on this very grid: the sender and the
 * amount are printed two rows above it. A previous pass dropped the render and
 * put docs.sections.stealthAddresses.detail6 there instead, "v2: X25519 +
 * ML-KEM-768 (FIPS 203) hybrid ECDH, quantum-resistant", which was worse in
 * three ways. It introduced a post-quantum claim the page never made. It is a
 * bullet out of the middle of the docs list, so the reader met a bare "v2:" with
 * no v1 and no v2 defined anywhere on the page. And in this app the ML-KEM-768
 * hybrid is the note-encryption transport (lib/privacy/pool/noteCrypto.ts, HKDF
 * info "p01-note-enc-mlkem-v1", the sealed blob a recipient opens), not the
 * stealth-address derivation the To row is about, so the property was pinned to
 * the wrong mechanism. i18n/ is off limits here, so the honest sentence for
 * explorer.observer.footnote is reported upward and this slot renders the key.
 *
 * The right column is headed with the wordmark rather than
 * explorer.observer.protocol01, whose value is the identical string
 * "Protocol 01" in en.ts and fr.ts. Swapping a proper noun that both
 * dictionaries spell the same way costs no French, and the key itself is
 * reported for rewrite because a dead retired-brand string is still a
 * retired-brand string.
 */

/** The new wordmark. Same in both locales, which is why it can be a literal. */
const STYX = "Styx";

/**
 * One illustrative payment, drawn twice. Locale-neutral on purpose.
 *
 * These are not records: no company is named and no amount is a measurement.
 * The DEMO chip above the grid says so in both locales, via demo.badge.
 */
const PAYER = "7xKQ…3fUw";
const PAYEE_WALLET = "9mPa…Rt2c";
const PAYEE_ONE_TIME = "4vTn…8qLd";
const AMOUNT = "12.00 USDC";
const MEMO = "“monthly-plan”";

/**
 * A redaction, not a word.
 *
 * The one field a Styx transfer genuinely does not carry. Block glyphs are what
 * the pre-port module printed, they read the same in every language, and
 * .styx-redacted turns them into a faint bar rather than a heavy black one.
 */
const SEALED = "██████";

function LedgerRow({
  label,
  value,
  sealed,
}: {
  label: string;
  value?: string;
  sealed?: boolean;
}) {
  return (
    <div className="styx-row">
      <span className="styx-row-key">{label}</span>
      <span className="styx-row-leader" aria-hidden="true" />
      {sealed ? (
        /* Hidden from assistive technology: a screen reader then reads the row
           as a key with no value, which is exactly what an absent field is. A
           spoken alternative would have to be a sentence, and a sentence here
           would have to be English. */
        <span className="styx-row-value styx-redacted" aria-hidden="true">
          {SEALED}
        </span>
      ) : (
        <span className="styx-row-value">{value}</span>
      )}
    </div>
  );
}

function ObserverTest() {
  const t = useT();

  return (
    <div>
      {/* The rows below are an illustration. demo.badge is "DEMO" in both
          dictionaries, so the disclosure survives the locale. */}
      <div style={{ marginBottom: "1.5rem" }}>
        <span className="styx-chip">{t("demo.badge")}</span>
      </div>

      <div className="styx-grid styx-grid-2">
        {/* An ordinary transfer, as anyone reads it. */}
        <div className="styx-card">
          <p className="styx-overline" style={{ marginBottom: "1.1rem" }}>
            {t("explorer.observer.standardChain")}
          </p>
          <LedgerRow label={t("explorer.observer.from")} value={PAYER} />
          <LedgerRow label={t("explorer.observer.to")} value={PAYEE_WALLET} />
          <LedgerRow label={t("explorer.observer.amount")} value={AMOUNT} />
          <LedgerRow label={t("explorer.observer.memo")} value={MEMO} />
        </div>

        {/* The same payment through Styx. The cyan dot is the only seal. */}
        <div className="styx-card">
          <p
            className="styx-overline"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.45rem",
              marginBottom: "1.1rem",
            }}
          >
            <span className="styx-dot" aria-hidden="true" />
            {STYX}
          </p>
          {/* Same signer, same value, both public. */}
          <LedgerRow label={t("explorer.observer.from")} value={PAYER} />
          <LedgerRow
            label={t("explorer.observer.to")}
            value={PAYEE_ONE_TIME}
          />
          <LedgerRow label={t("explorer.observer.amount")} value={AMOUNT} />
          {/* The only field that is genuinely absent. */}
          <LedgerRow label={t("explorer.observer.memo")} sealed />
          <div className="styx-row">
            <span className="styx-row-key">
              {t("explorer.observer.proof")}
            </span>
            <span className="styx-row-leader" aria-hidden="true" />
            <span className="styx-row-value">
              <span className="styx-check" aria-hidden="true">
                &#10003;
              </span>
              C3 Merkle Path
            </span>
          </div>
        </div>
      </div>

      {/* The grid's own footnote, restored, because the grid needs one: From and
          Amount print the same value on both sides and a reader is owed the
          reason. explorer.observer.footnote is the key that belongs in this slot
          and its current sentence is false, so the replacement is reported
          upward rather than rendered around. */}
      <p className="styx-note" style={{ marginTop: "1.5rem" }}>
        {t("explorer.observer.footnote")}
      </p>
    </div>
  );
}

export default memo(ObserverTest);
