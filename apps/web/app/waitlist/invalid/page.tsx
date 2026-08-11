import type { Metadata } from "next";
import StyxShell from "../../_styx/StyxShell";
import InvalidResult from "./InvalidResult";

/**
 * /waitlist/invalid
 *
 * The dead end that app/api/waitlist/confirm and app/api/waitlist/unsubscribe
 * both 302 to, by literal path. This directory and file name are load-bearing:
 * do not move or rename them.
 *
 * The page itself is a server component so it can carry a title. Everything
 * that needs a hook lives in ./InvalidResult.
 */
export const metadata: Metadata = {
  title: "Link expired or invalid · Styx Protocol",
  description: "This waitlist confirmation link was not accepted.",
};

export default function WaitlistInvalidPage() {
  return (
    <StyxShell>
      <InvalidResult />
    </StyxShell>
  );
}
