"use client";

import { useT } from "@/i18n";

/**
 * The two exits at the foot of /waitlist.
 *
 * A component this small exists for one reason: t() is a context hook, and
 * page.tsx has to stay a server component so it can export metadata. Both labels
 * are t() calls, so neither is hardcoded English and both render in French.
 *
 * The first label is NOT waitlist.heroCta. That key is the submit button's label
 * up in the hero, and using it here gave a button and an anchor the same
 * accessible name for two different actions: one posts the form, this one only
 * scrolls. waitlist.backToForm says what the link does.
 *
 * The first link targets #join, which is the id on the form panel in
 * ./WaitlistJoin.tsx. Do not point it at the top of the page: the form is in the
 * hero's second column, and on a narrow viewport it sits below the lede.
 */
export default function WaitlistExits() {
  const t = useT();

  return (
    <div className="styx-btn-row">
      <a className="styx-btn-ghost" href="#join">
        {t("waitlist.backToForm")}
      </a>
      <a className="styx-btn-ghost" href="/docs">
        {t("hero.documentation")}
      </a>
    </div>
  );
}
