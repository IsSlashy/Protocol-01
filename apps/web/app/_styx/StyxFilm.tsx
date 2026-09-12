"use client";

import { useRef, useState } from "react";
import { useT } from "@/i18n";

/**
 * StyxFilm — the presentation film, behind a poster the page actually designed.
 *
 * WHAT WAS WRONG. The section shipped a bare <video controls poster=…>. Three
 * consequences, all visible in the screenshot taken on 2026-09-09: the first
 * thing a visitor saw of the product was Chrome's default control bar over a
 * poster frame that is itself a title card of English text; the film's length
 * was unknowable without pressing play; and the whole thing sat in a
 * 16:9 box with no affordance, so it did not read as playable at all.
 *
 * WHAT THIS DOES. The poster frame is drawn over, not replaced: the film's own
 * title card stays as the ground, dimmed, with a hairline play target and the
 * runtime on it. Pressing it swaps in the real <video autoPlay controls>, which
 * is also the first moment the 5.4 MB file is fetched — `preload` never runs on
 * the poster state, so the landing page does not pay for a film most visitors
 * will not watch.
 *
 * WHY IT STILL DOES NOT AUTOPLAY. The film is narrated. An autoplaying muted
 * loop would be the wrong artefact here — that job belongs to the device in the
 * hero, which is a silent drawing on purpose. This is a two-minute film and it
 * starts when someone asks for it.
 *
 * The label is `demo.play`, added to both dictionaries in the same change;
 * `2:00` is a numeral and reads the same in both locales.
 */
export default function StyxFilm() {
  const t = useT();
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  if (!playing) {
    return (
      <button
        type="button"
        className="styx-film"
        onClick={() => setPlaying(true)}
      >
        <img
          className="styx-film-poster"
          src="/videos/styx-presentation.jpg"
          alt=""
          loading="lazy"
          decoding="async"
        />
        <span className="styx-film-scrim" />
        <span className="styx-film-cue">
          <span className="styx-film-triangle" aria-hidden="true" />
          <span className="styx-film-label">{t("demo.play")}</span>
        </span>
        <span className="styx-film-runtime" aria-hidden="true">
          2:00
        </span>
      </button>
    );
  }

  return (
    <video
      ref={videoRef}
      className="styx-film-video"
      src="/videos/styx-presentation.mp4"
      poster="/videos/styx-presentation.jpg"
      controls
      autoPlay
      playsInline
    />
  );
}
