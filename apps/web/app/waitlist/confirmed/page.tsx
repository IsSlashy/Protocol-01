"use client";

import WaitlistResult from "../WaitlistResult";

export default function WaitlistConfirmedPage() {
  return (
    <WaitlistResult
      variant="confirmed"
      titleKey="waitlist.confirmedTitle"
      bodyKey="waitlist.confirmedBody"
    />
  );
}
