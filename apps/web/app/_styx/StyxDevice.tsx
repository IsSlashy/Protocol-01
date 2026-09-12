"use client";

import { useEffect, useState } from "react";
import { useT } from "@/i18n";

/**
 * StyxDevice — the product shot the landing page did not have.
 *
 * WHY THIS EXISTS. Measured on the live page, 2026-09-09: the homepage carried
 * 1 060 words and 4 media elements over 8 170 px. solanamobile.com/seeker says
 * its whole argument in 353 words over 8 452 px, because it SHOWS the phone;
 * apple.com/fr runs 287 words of body copy against 82 images. Styx ships a
 * mobile app, an extension and a web app, and a visitor could not see a single
 * one of them: the only product visual was a video whose first frame is more
 * text. This is the missing frame.
 *
 * WHY IT IS DRAWN AND NOT PHOTOGRAPHED. public/ holds no screenshot of the
 * app and no ffmpeg exists on this machine to cut one out of
 * /videos/styx-presentation.mp4, so a render was the only honest option. It is
 * also the better one: a screenshot would be a JPEG of a devnet build that
 * drifts the day the UI moves, while this is composed from the same design
 * tokens as the rest of the page and cannot go stale in the same way.
 *
 * EVERY VISIBLE STRING IS A DICTIONARY KEY, from the `mockup.*` block that
 * i18n/en.ts and i18n/fr.ts already carry in parity for components/
 * PhoneMockup.tsx. Nothing is written into this JSX: a hardcoded English
 * sentence renders fine for an English visitor and silently deletes the French
 * one, which is the exact regression app/_home/HomeSections.tsx documents at
 * its top. The only literals are numerals and token tickers, which are the same
 * word in both locales.
 *
 * WHICH SCREENS, AND WHY THESE THREE. hero.desc1 promises three things — pay a
 * merchant, subscribe, send — so the device shows those three and nothing else.
 * `mockup.privateSend` / `privateSendDesc` ("Route through multiple wallets
 * with time delays") and the whole `mockup.privacyAgent` view are deliberately
 * NOT rendered: multi-hop routing and the on-device assistant are two of the
 * eight module cards that were dropped from this page for claiming behaviour a
 * visitor cannot exercise on devnet today, and a mockup is not a loophole for
 * putting them back.
 *
 * THE FIGURES ARE AN INTERFACE PREVIEW, NOT A MEASUREMENT. They are balances in
 * a drawing, so the status bar and the screen body are aria-hidden and a screen
 * reader never reads a fake ledger row by row. What it gets instead is the
 * figcaption, `mockup.tapToExplore`, and the three tab buttons, which are real
 * controls and stay in the tree.
 *
 * MOTION. The screens advance on a 4.6 s interval, pause while the pointer is
 * on the device, and do not advance at all under prefers-reduced-motion, where
 * the tabs remain the way through. The interval is cleared on unmount, which
 * also keeps the jsdom render in __tests__/pages/Homepage.test.tsx quiet.
 */

type ScreenId = "wallet" | "privacy" | "streams";

const SCREENS: ScreenId[] = ["wallet", "privacy", "streams"];

/** The tab label for each screen, in the order the device cycles them. */
const TAB_KEY: Record<ScreenId, string> = {
  wallet: "mockup.tabWallet",
  privacy: "mockup.tabPrivacy",
  streams: "mockup.tabStreams",
};

const CYCLE_MS = 4600;

export default function StyxDevice() {
  const t = useT();
  const [active, setActive] = useState<ScreenId>("wallet");
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const id = window.setInterval(() => {
      setActive((current) => {
        const next = (SCREENS.indexOf(current) + 1) % SCREENS.length;
        return SCREENS[next];
      });
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, [paused]);

  return (
    <figure className="styx-device-figure">
      <div
        className="styx-device"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        {/* The glass.

            WHAT IS HIDDEN AND WHAT IS NOT. The status bar and the screen body
            are aria-hidden: the numerals in them are a drawing, and a screen
            reader announcing a balance it cannot verify is worse than silence.
            The tab bar is NOT hidden, because it is the control — three real
            buttons in the place a phone puts them. An earlier pass had them
            aria-hidden and repeated the same three labels in a switch below the
            frame, which printed "Wallet Privacy Streams" twice on the page.
            One row, doing both jobs. */}
        <div className="styx-device-frame">
          <div className="styx-device-notch" aria-hidden="true" />
          <div className="styx-device-screen">
            <div className="styx-device-statusbar" aria-hidden="true">
              <span>9:41</span>
              <span className="styx-device-signal">
                <i />
                <i />
                <i />
              </span>
            </div>

            <div className="styx-device-body" aria-hidden="true">
              {active === "wallet" ? <WalletScreen t={t} /> : null}
              {active === "privacy" ? <PrivacyScreen t={t} /> : null}
              {active === "streams" ? <StreamsScreen t={t} /> : null}
            </div>

            <div className="styx-device-tabs" role="tablist">
              {SCREENS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={id === active}
                  className="styx-device-tab"
                  data-active={id === active}
                  onClick={() => setActive(id)}
                >
                  {t(TAB_KEY[id])}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <figcaption className="styx-device-caption">
        {t("mockup.tapToExplore")}
      </figcaption>
    </figure>
  );
}

type T = (key: string) => string;

function WalletScreen({ t }: { t: T }) {
  return (
    <div className="styx-device-view" key="wallet">
      <p className="styx-device-label">{t("mockup.totalBalance")}</p>
      <p className="styx-device-amount">
        24.81 <span>SOL</span>
      </p>

      <div className="styx-device-actions">
        <span className="styx-device-action">{t("mockup.send")}</span>
        <span className="styx-device-action">{t("mockup.receive")}</span>
        <span className="styx-device-action">{t("mockup.swap")}</span>
      </div>

      <p className="styx-device-section">{t("mockup.assets")}</p>
      <DeviceRow name={t("mockup.solanaName")} meta="SOL" value="18.40" />
      <DeviceRow name={t("mockup.usdcName")} meta="USDC" value="1 240.00" />

      <p className="styx-device-section">{t("mockup.recentActivity")}</p>
      <DeviceRow
        name={t("mockup.shield")}
        meta={`${t("mockup.zkPool")} · ${t("mockup.time2m")}`}
        value="1.00"
        accent
      />
      <DeviceRow
        name={t("mockup.sentSol")}
        meta={`${t("mockup.toPeer")} · ${t("mockup.time15m")}`}
        value="0.50"
      />
    </div>
  );
}

function PrivacyScreen({ t }: { t: T }) {
  return (
    <div className="styx-device-view" key="privacy">
      <p className="styx-device-label">{t("mockup.shieldedBalance")}</p>
      <p className="styx-device-amount">
        3.00 <span>SOL</span>
      </p>

      <div className="styx-device-chips">
        <span className="styx-device-chip" data-tone="ready">
          {t("mockup.notesReady")}
        </span>
        <span className="styx-device-chip">{t("mockup.notesMaturing")}</span>
      </div>

      <div className="styx-device-actions">
        <span className="styx-device-action">{t("mockup.deposit")}</span>
        <span className="styx-device-action">{t("mockup.withdraw")}</span>
      </div>

      <p className="styx-device-section">{t("mockup.yourNotes")}</p>
      <DeviceRow name="1.00 SOL" meta={t("mockup.readyToUse")} value="◆" accent />
      <DeviceRow name="1.00 SOL" meta={t("mockup.readyToUse")} value="◆" accent />
      <DeviceRow name="1.00 SOL" meta={t("mockup.maturingDots")} value="◇" />
    </div>
  );
}

function StreamsScreen({ t }: { t: T }) {
  return (
    <div className="styx-device-view" key="streams">
      <p className="styx-device-label">{t("mockup.streams")}</p>

      <div className="styx-device-stats">
        <span>
          <b>3</b>
          {t("mockup.active")}
        </span>
        <span>
          <b>0.42</b>
          {t("mockup.solPerMo")}
        </span>
        <span>
          <b>{t("mockup.next3")}</b>
          {t("mockup.next")}
        </span>
      </div>

      <p className="styx-device-section">{t("mockup.services")}</p>
      <DeviceRow
        name={t("mockup.gymMembership")}
        meta={`${t("mockup.monthly")} · ${t("mockup.next3")}`}
        value="0.12"
      />
      <DeviceRow
        name={t("mockup.music")}
        meta={`${t("mockup.monthly")} · ${t("mockup.next7")}`}
        value="0.05"
      />

      <p className="styx-device-section">{t("mockup.personal")}</p>
      <DeviceRow
        name={t("mockup.rentAnna")}
        meta={`${t("mockup.recurringPayment")} · ${t("mockup.next11")}`}
        value="0.25"
      />
    </div>
  );
}

function DeviceRow({
  name,
  meta,
  value,
  accent = false,
}: {
  name: string;
  meta: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="styx-device-row">
      <span className="styx-device-row-mark" data-accent={accent} />
      <span className="styx-device-row-text">
        <b>{name}</b>
        <i>{meta}</i>
      </span>
      <span className="styx-device-row-value">{value}</span>
    </div>
  );
}
