/**
 * Waitlist confirmation emails (Resend).
 *
 * Reuses the dark branded card style from app/api/whitelist/route.ts. Copy is
 * localized (en/fr/ja) from the record's locale and follows the project voice:
 * no em-dashes, no arrows, no shouting. Every email carries a one-click
 * unsubscribe link (the same token, which stays valid after confirmation).
 */
import { Resend } from 'resend';
import type { Locale } from './validate';

const SITE_URL = process.env.SITE_URL ?? 'https://protocol-01.dev';
const RESEND_PLACEHOLDER = 're_YOUR_API_KEY_HERE';

// Lazy init so a missing key never breaks the build (mirrors whitelist route).
let resend: Resend | null = null;
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key || key === RESEND_PLACEHOLDER) return null;
  if (!resend) resend = new Resend(key);
  return resend;
}

/** True when a usable Resend key is present (surfaced in the stats endpoint). */
export function isResendConfigured(): boolean {
  const key = process.env.RESEND_API_KEY;
  return !!key && key !== RESEND_PLACEHOLDER;
}

function emailFrom(): string {
  return process.env.EMAIL_FROM || 'Protocol 01 <onboarding@resend.dev>';
}

interface Copy {
  subject: string;
  heading: string;
  body: string;
  button: string;
  disclaimer: string;
  ignore: string;
  unsubscribe: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: 'Confirm your spot on the Protocol 01 waitlist',
    heading: 'You are almost in',
    body: 'Thanks for joining the Protocol 01 waitlist. Confirm your email to secure your spot and we will let you know the moment early access opens.',
    button: 'Confirm my spot',
    disclaimer: 'You signed up on protocol-01.dev.',
    ignore: 'If this was not you, you can safely ignore this email and nothing will happen.',
    unsubscribe: 'Unsubscribe',
  },
  fr: {
    subject: 'Confirmez votre place sur la liste d’attente Protocol 01',
    heading: 'Vous y êtes presque',
    body: 'Merci d’avoir rejoint la liste d’attente Protocol 01. Confirmez votre e-mail pour réserver votre place et nous vous préviendrons dès l’ouverture de l’accès anticipé.',
    button: 'Confirmer ma place',
    disclaimer: 'Vous vous êtes inscrit sur protocol-01.dev.',
    ignore: 'Si ce n’était pas vous, vous pouvez ignorer cet e-mail sans risque.',
    unsubscribe: 'Se désinscrire',
  },
  ja: {
    subject: 'Protocol 01 ウェイトリストの確認',
    heading: '登録まであと少しです',
    body: 'Protocol 01 のウェイトリストにご参加いただきありがとうございます。メールアドレスを確認して登録を完了してください。早期アクセスが開始され次第、お知らせします。',
    button: '登録を確定する',
    disclaimer: 'protocol-01.dev で登録されました。',
    ignore: 'お心当たりがない場合は、このメールを無視していただいて問題ありません。',
    unsubscribe: '配信を停止する',
  },
};

function renderHtml(copy: Copy, confirmUrl: string, unsubscribeUrl: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #0a0a0c; color: #ffffff;">
      <div style="text-align: center; margin-bottom: 32px;">
        <h1 style="color: #39c5bb; font-size: 28px; margin: 0;">Protocol 01</h1>
        <p style="color: #888; margin-top: 8px;">Privacy-First Payments on Solana</p>
      </div>

      <div style="background: #151518; border: 1px solid #2a2a30; border-radius: 12px; padding: 28px; margin-bottom: 24px;">
        <h2 style="color: #39c5bb; font-size: 20px; margin: 0 0 16px 0;">${copy.heading}</h2>
        <p style="color: #ccc; line-height: 1.6; margin: 0 0 24px 0;">${copy.body}</p>

        <div style="text-align: center; margin: 8px 0 4px 0;">
          <a href="${confirmUrl}" style="display: inline-block; background: #39c5bb; color: #0a0a0c; padding: 14px 36px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">
            ${copy.button}
          </a>
        </div>
      </div>

      <div style="text-align: center;">
        <p style="color: #666; font-size: 12px; line-height: 1.6; margin: 0 0 4px 0;">
          ${copy.disclaimer} ${copy.ignore}
        </p>
      </div>

      <div style="margin-top: 28px; padding-top: 24px; border-top: 1px solid #2a2a30; text-align: center;">
        <p style="color: #555; font-size: 12px; margin: 0 0 8px 0;">
          Protocol 01 - Privacy-First Payments on Solana<br>
          © 2026 Volta Team
        </p>
        <p style="margin: 0;">
          <a href="${unsubscribeUrl}" style="color: #ff2d7a; font-size: 12px; text-decoration: none;">${copy.unsubscribe}</a>
        </p>
      </div>
    </div>
  `;
}

/**
 * Send the double opt-in confirmation email. Returns true on a successful send,
 * false when Resend is not configured or the send throws. Callers treat false
 * as a mail failure but keep the stored signup either way.
 */
export async function sendConfirmationEmail(params: {
  email: string;
  token: string;
  locale: Locale;
}): Promise<boolean> {
  const client = getResend();
  if (!client) return false;

  const copy = COPY[params.locale];
  const confirmUrl = `${SITE_URL}/api/waitlist/confirm?token=${params.token}`;
  const unsubscribeUrl = `${SITE_URL}/api/waitlist/unsubscribe?token=${params.token}`;

  try {
    const { error } = await client.emails.send({
      from: emailFrom(),
      to: params.email,
      subject: copy.subject,
      html: renderHtml(copy, confirmUrl, unsubscribeUrl),
    });
    if (error) {
      console.error('[waitlist] Resend returned an error:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[waitlist] Failed to send confirmation email:', err);
    return false;
  }
}
