import { NextResponse } from 'next/server';

/**
 * RETIRED, 2026-09-02. Answers 410 on every method.
 *
 * This route used to take a note IN: verify its opening, queue it for a
 * conversion worker to spend, and mint a ticket to be filled once the
 * conversion landed. Both ends were dead. No worker ever existed to drain the
 * queue, and no client ever called it: the panel action named after it
 * (`SubscribePanel.swapForIssuedNote`) re-sent an empty claim code to
 * `issue-note` and got 402 every time.
 *
 * The mechanism it was waiting for turned out not to need a queue at all. A
 * note is taken in by SPENDING it, and the holder can do that themselves: a
 * circuit-7 withdrawal whose recipient is the till, signed by an ephemeral the
 * float funded, claimed at `/api/claim-for-payment` (kind `pool-withdrawal`,
 * floor lowered by the pool's own fee) and redeemed at `/api/issue-note`. The
 * note handed in is dead before a replacement exists, because the withdrawal
 * IS the spend, so the drain this route was built around cannot occur; and no
 * opening is ever sent to a server, so nothing is held at rest.
 *
 * Nothing here reads or writes the store. The queue and ticket keys the old
 * route wrote are gone with it.
 */

const REPLACEMENT = '/api/claim-for-payment (pool-withdrawal) then /api/issue-note';

function gone() {
  return NextResponse.json(
    {
      ok: false,
      error:
        'swap-note is retired. Take a note in by withdrawing it to the till (circuit 7), then ' +
        'claim the payment and redeem the claim.',
      replacement: REPLACEMENT,
    },
    { status: 410 },
  );
}

export async function GET() {
  return gone();
}

export async function POST() {
  return gone();
}
