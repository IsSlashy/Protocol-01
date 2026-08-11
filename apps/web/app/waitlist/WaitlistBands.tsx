"use client";

import { useT } from "@/i18n";
import Reveal from "../_styx/Reveal";
import WaitlistExits from "./WaitlistExits";
import { SERIF_TITLE, SERIF_SMALL } from "./serif";

/**
 * The three evidence bands of /waitlist: the mechanism, the record, the project.
 *
 * WHY THIS IS A CLIENT COMPONENT and not part of page.tsx. t() is a context hook
 * and page.tsx has to stay a server component so it can export metadata. These
 * bands used to be written inline up there, which made them ~1,400 words of
 * hardcoded English underneath a hero that was fully translated: a French visitor
 * got a French heading and then an English page. Moving them here is what lets
 * every sentence be a t() call. app/_home/HomeSections.tsx is the same split for
 * the same reason.
 *
 * Every string a reader can read comes from the dictionary. The literals left in
 * this file are the ones that are the same in every language: file paths, route
 * paths, constant names from the source, field names from the WaitlistRecord
 * interface, the enum values those fields accept, and the cron expression. They
 * are the evidence, they are rendered in the mono voice, and translating
 * `MAX_RESENDS = 5` would make it less checkable, not more.
 *
 * Copy rule for this page: nothing here that a reader cannot check. Every claim
 * in bands 01 and 02 is a line in app/api/waitlist/*, lib/waitlist/store.ts or
 * lib/waitlist/validate.ts, the cron line is the one in the repo root
 * vercel.json, and band 03 says what is missing rather than waiting to be asked.
 *
 * Verified on 2026-08-11 against the source, since every one of these is a
 * number a reader can hold us to:
 *   - RESEND_INTERVAL_MS = 10 min, MAX_RESENDS = 5   app/api/waitlist/route.ts:25
 *   - reminder delay 24h, REMIND_WINDOW_DAYS = 7     remind/route.ts:35, :39
 *   - PURGE_DAYS = 30                                remind/route.ts:36
 *   - cron "0 10 * * *" on /api/waitlist/remind      ../../../vercel.json:9
 *   - rate limit 20 per IP per UTC hour, hash kept
 *     3600s, raw IP never stored                     lib/waitlist/store.ts:334
 *   - twelve fields in WaitlistRecord                lib/waitlist/store.ts:29
 */
export default function WaitlistBands() {
  const t = useT();

  return (
    <>
      {/* ── 01 · What happens after you submit ─────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <p className="styx-index">{t("waitlist.mechIndex")}</p>
            <h2 className="styx-h2" style={SERIF_TITLE}>
              {t("waitlist.mechTitle")}
            </h2>
          </div>
          <div>
            <div className="styx-prose">
              <p>{t("waitlist.mechLede")}</p>
            </div>

            {/* Each step carries one mono line naming the file that implements
                it, so the sentence above it can stay a sentence in both locales
                and the path stays in the evidence voice. */}
            <ul className="styx-steps">
              <Reveal as="li" className="styx-step styx-reveal">
                <span className="styx-step-index">01</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_SMALL}>
                    {t("waitlist.step1Title")}
                  </h3>
                  <p className="styx-step-body">{t("waitlist.step1Body")}</p>
                  <p className="styx-mono" style={{ margin: "0.7rem 0 0" }}>
                    app/api/waitlist/route.ts &middot; MAX_RESENDS = 5
                  </p>
                </div>
              </Reveal>
              <Reveal as="li" className="styx-step styx-reveal" delay={80}>
                <span className="styx-step-index">02</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_SMALL}>
                    {t("waitlist.step2Title")}
                  </h3>
                  <p className="styx-step-body">{t("waitlist.step2Body")}</p>
                  <p className="styx-mono" style={{ margin: "0.7rem 0 0" }}>
                    app/api/waitlist/confirm/route.ts &middot; /waitlist/confirmed
                    &middot; /waitlist/invalid
                  </p>
                </div>
              </Reveal>
              <Reveal as="li" className="styx-step styx-reveal" delay={160}>
                <span className="styx-step-index">03</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_SMALL}>
                    {t("waitlist.step3Title")}
                  </h3>
                  <p className="styx-step-body">{t("waitlist.step3Body")}</p>
                  <p className="styx-mono" style={{ margin: "0.7rem 0 0" }}>
                    app/api/waitlist/remind/route.ts &middot; cron 0 10 * * *
                  </p>
                </div>
              </Reveal>
              <Reveal as="li" className="styx-step styx-reveal" delay={240}>
                <span className="styx-step-index">04</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_SMALL}>
                    {t("waitlist.step4Title")}
                  </h3>
                  <p className="styx-step-body">{t("waitlist.step4Body")}</p>
                  <p className="styx-mono" style={{ margin: "0.7rem 0 0" }}>
                    app/api/waitlist/unsubscribe/route.ts &middot;
                    /waitlist/removed
                  </p>
                </div>
              </Reveal>
              <Reveal as="li" className="styx-step styx-reveal" delay={320}>
                <span className="styx-step-index">05</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_SMALL}>
                    {t("waitlist.step5Title")}
                  </h3>
                  <p className="styx-step-body">{t("waitlist.step5Body")}</p>
                  <p className="styx-mono" style={{ margin: "0.7rem 0 0" }}>
                    app/api/waitlist/remind/route.ts &middot; PURGE_DAYS = 30
                  </p>
                </div>
              </Reveal>
            </ul>
          </div>
        </div>
      </section>

      {/* ── 02 · What is stored ────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              02
            </span>
            <p className="styx-index">{t("waitlist.recordIndex")}</p>
            <h2 className="styx-h2" style={SERIF_TITLE}>
              {t("waitlist.recordTitle")}
            </h2>
          </div>
          <div className="styx-stack-lg">
            <div className="styx-prose">
              <p>{t("waitlist.recordLede")}</p>
            </div>

            {/* Row keys are the field names of the WaitlistRecord interface at
                lib/waitlist/store.ts:29, and the values are the literals the
                code accepts, so the panel can be diffed against the type. The
                three sending and confirming stamps share the `timestamps` row,
                which is what makes the count twelve. The last row is not a field
                at all, which is the whole point of it. */}
            <Reveal className="styx-panel styx-reveal">
              <div className="styx-panel-head">
                <p className="styx-overline">
                  WaitlistRecord &middot; lib/waitlist/store.ts
                </p>
                <p className="styx-h3" style={{ ...SERIF_SMALL, margin: "0.5rem 0 0" }}>
                  {t("waitlist.recordPanelTitle")}
                </p>
              </div>
              <div className="styx-panel-body">
                <div className="styx-row">
                  <span className="styx-row-key">email</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">{t("waitlist.rowEmail")}</span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">status</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">pending &middot; confirmed</span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">tokenHash</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">sha256(token)</span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">interest</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">
                    mobile &middot; extension &middot; sdk
                  </span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">locale</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">en &middot; fr</span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">source</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">
                    waitlist-page &middot; ?src=
                  </span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">country</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">ISO 3166-1 alpha-2</span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">timestamps</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">
                    createdAt &middot; lastSentAt &middot; confirmedAt
                  </span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">remindedAt</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">
                    {t("waitlist.rowReminded")}
                  </span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">resendCount</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">
                    {t("waitlist.rowResends")}
                  </span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">ip</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value styx-redacted">
                    {t("waitlist.rowIp")}
                  </span>
                </div>
              </div>
            </Reveal>

            <div className="styx-prose">
              <p>
                <strong>{t("waitlist.tokenNoteTitle")}</strong>{" "}
                {t("waitlist.tokenNoteBody")}
              </p>
              <p>
                <strong>{t("waitlist.ipNoteTitle")}</strong>{" "}
                {t("waitlist.ipNoteBody")}
              </p>
              <p>
                <strong>{t("waitlist.localeNoteTitle")}</strong>{" "}
                {t("waitlist.localeNoteBody")}
              </p>
              {/* The whole sentence is the link, rather than a fragment of it
                  glued to an anchor: the word order around "privacy page"
                  differs per locale and gluing fragments breaks French. */}
              <p>
                <a className="styx-link" href="/privacy">
                  {t("waitlist.privacyLink")}
                </a>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── 03 · What you are joining ──────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              03
            </span>
            <p className="styx-index">{t("waitlist.projectIndex")}</p>
            <h2 className="styx-h2" style={SERIF_TITLE}>
              {t("waitlist.projectTitle")}
            </h2>
          </div>
          <div className="styx-stack-lg">
            <div className="styx-grid styx-grid-4">
              <Reveal className="styx-card styx-reveal">
                <p className="styx-card-label">{t("waitlist.cardProofLabel")}</p>
                <p className="styx-card-value">{t("waitlist.cardProofValue")}</p>
                <p className="styx-card-note">{t("waitlist.cardProofNote")}</p>
              </Reveal>
              <Reveal className="styx-card styx-reveal" delay={80}>
                <p className="styx-card-label">{t("waitlist.cardKemLabel")}</p>
                {/* Notation, not copy: identical in both locales. */}
                <p className="styx-card-value">X25519 + ML-KEM-768</p>
                <p className="styx-card-note">{t("waitlist.cardKemNote")}</p>
              </Reveal>
              <Reveal className="styx-card styx-reveal" delay={160}>
                <p className="styx-card-label">{t("waitlist.cardStatusLabel")}</p>
                {/* The network's name, not a word. */}
                <p className="styx-card-value">Devnet</p>
                <p className="styx-card-note">{t("waitlist.cardStatusNote")}</p>
              </Reveal>
              <Reveal className="styx-card styx-reveal" delay={240}>
                <p className="styx-card-label">{t("waitlist.cardAuditLabel")}</p>
                <p className="styx-card-value">{t("waitlist.cardAuditValue")}</p>
                <p className="styx-card-note">{t("waitlist.cardAuditNote")}</p>
              </Reveal>
            </div>

            <div className="styx-prose">
              <p>{t("waitlist.projectNoteSignatures")}</p>
              <p>{t("waitlist.projectNoteInterest")}</p>
              {/* Same rule as the privacy link above: the sentence is the link. */}
              <p>
                <a className="styx-link" href="/roadmap">
                  {t("waitlist.roadmapLink")}
                </a>
              </p>
            </div>

            {/* The page's single amber element. */}
            <div className="styx-admission">
              <p className="styx-admission-title">
                {t("waitlist.admissionTitle")}
              </p>
              <p className="styx-admission-body">
                {t("waitlist.admissionBody")}
              </p>
            </div>

            <div className="styx-gleam-rule" aria-hidden="true" />

            <WaitlistExits />
          </div>
        </div>
      </section>
    </>
  );
}
