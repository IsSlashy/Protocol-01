import { NextResponse } from 'next/server';
import { checkAdminAuth } from '@/lib/waitlist/auth';
import { getStore, kvConfigured, collectStats } from '@/lib/waitlist/store';
import { isResendConfigured } from '@/lib/waitlist/email';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = checkAdminAuth(req);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.status === 503 ? 'not_configured' : 'unauthorized' },
      { status: auth.status },
    );
  }

  const stats = await collectStats(getStore());

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    config: {
      kv: kvConfigured,
      resend: isResendConfigured(),
      emailFrom: process.env.EMAIL_FROM ?? null,
      siteUrl: process.env.SITE_URL ?? 'https://protocol-01.dev',
    },
    ...stats,
  });
}
