"use client";

import WaitlistResult from "../WaitlistResult";

export default function WaitlistInvalidPage() {
  return (
    <WaitlistResult
      variant="invalid"
      titleKey="waitlist.invalidTitle"
      bodyKey="waitlist.invalidBody"
    />
  );
}
