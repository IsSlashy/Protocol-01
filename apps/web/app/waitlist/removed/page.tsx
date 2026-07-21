"use client";

import WaitlistResult from "../WaitlistResult";

export default function WaitlistRemovedPage() {
  return (
    <WaitlistResult
      variant="removed"
      titleKey="waitlist.removedTitle"
      bodyKey="waitlist.removedBody"
    />
  );
}
