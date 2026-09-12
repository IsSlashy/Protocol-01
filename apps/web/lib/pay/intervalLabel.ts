/**
 * The billing interval, in the reader's language.
 *
 * WHY THIS IS A DISPLAY-SIDE MAP AND NOT A CHANGE TO `formatInterval`.
 *
 * `formatInterval` lives in lib/privacy/serviceRegistry.ts, takes no locale,
 * has its own tests, and is called from places that have no translator. Adding
 * a locale parameter to it would ripple through all of them for one label. So
 * its ENGLISH answer stays the single source of the arithmetic — which slot
 * count means "monthly", where the day/hour/second cutoffs are — and this maps
 * that answer onto a dictionary key at the point it is shown to someone.
 *
 * ⚠️ THE FALLBACK IS THE INPUT, NOT A GUESS. Anything this does not recognise
 * is returned unchanged, so a new shape added to `formatInterval` shows up in
 * English rather than disappearing or rendering a raw key. That is the failure
 * this function is allowed to have; silently dropping an interval is not.
 */
export function translateInterval(
  formatted: string,
  t: (key: string) => string,
): string {
  switch (formatted) {
    case "monthly":
      return t("pay.shared.intervalMonthly");
    case "weekly":
      return t("pay.shared.intervalWeekly");
    case "biweekly":
      return t("pay.shared.intervalBiweekly");
    case "yearly":
      return t("pay.shared.intervalYearly");
    case "daily":
      return t("pay.shared.intervalDaily");
  }

  const days = /^every (\d+) days$/.exec(formatted);
  if (days) return t("pay.shared.intervalDays").replace("{n}", days[1]);

  const hours = /^every (\d+) h$/.exec(formatted);
  if (hours) return t("pay.shared.intervalHours").replace("{n}", hours[1]);

  const seconds = /^every (\d+) s$/.exec(formatted);
  if (seconds) return t("pay.shared.intervalSeconds").replace("{n}", seconds[1]);

  return formatted;
}
