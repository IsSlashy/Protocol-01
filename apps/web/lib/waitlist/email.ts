/**
 * Waitlist confirmation emails (Resend).
 *
 * Visual language mirrors the site: void-black background, sharp corners (no
 * border-radius anywhere), #39c5bb cyan / #ff2d7a pink accents, monospace
 * terminal details. Everything is inline-styled and table-based where it
 * matters (the CTA button) so Outlook and Gmail render it faithfully. Copy is
 * localized (en/fr/ja) from the record's locale and follows the project voice:
 * no em-dashes, no arrows, no shouting. Every email carries a one-click
 * unsubscribe link (the same token, which stays valid after confirmation) and
 * a plain-text part with raw URLs as a fallback.
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
  preheader: string;
  heading: string;
  body: string;
  button: string;
  linkHelp: string;
  disclaimer: string;
  ignore: string;
  unsubscribe: string;
}

const COPY: Record<Locale, Copy> = {
  en: {
    subject: 'Confirm your spot on the Protocol 01 waitlist',
    preheader: 'One click and your spot on the waitlist is locked.',
    heading: 'You are almost in',
    body: 'Thanks for joining the Protocol 01 waitlist. Confirm your email to secure your spot and we will let you know the moment early access opens.',
    button: 'Confirm my spot',
    linkHelp: 'Button not working? Paste this link into your browser:',
    disclaimer: 'You signed up on protocol-01.dev.',
    ignore: 'If this was not you, you can safely ignore this email and nothing will happen.',
    unsubscribe: 'Unsubscribe',
  },
  fr: {
    subject: 'Confirmez votre place sur la liste d’attente Protocol 01',
    preheader: 'Un clic et votre place sur la liste d’attente est réservée.',
    heading: 'Vous y êtes presque',
    body: 'Merci d’avoir rejoint la liste d’attente Protocol 01. Confirmez votre e-mail pour réserver votre place et nous vous préviendrons dès l’ouverture de l’accès anticipé.',
    button: 'Confirmer ma place',
    linkHelp: 'Le bouton ne fonctionne pas ? Collez ce lien dans votre navigateur :',
    disclaimer: 'Vous vous êtes inscrit sur protocol-01.dev.',
    ignore: 'Si ce n’était pas vous, vous pouvez ignorer cet e-mail sans risque.',
    unsubscribe: 'Se désinscrire',
  },
  ja: {
    subject: 'Protocol 01 ウェイトリストの確認',
    preheader: 'ワンクリックでウェイトリストの登録が完了します。',
    heading: '登録まであと少しです',
    body: 'Protocol 01 のウェイトリストにご参加いただきありがとうございます。メールアドレスを確認して登録を完了してください。早期アクセスが開始され次第、お知らせします。',
    button: '登録を確定する',
    linkHelp: 'ボタンが機能しない場合は、このリンクをブラウザに貼り付けてください。',
    disclaimer: 'protocol-01.dev で登録されました。',
    ignore: 'お心当たりがない場合は、このメールを無視していただいて問題ありません。',
    unsubscribe: '配信を停止する',
  },
};

const MONO = "'Courier New', Courier, monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

function renderHtml(copy: Copy, confirmUrl: string, unsubscribeUrl: string): string {
  return `
  <div style="background: #060608; padding: 32px 12px; font-family: ${SANS};">
    <!-- preheader: inbox preview text, invisible in the body -->
    <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">${copy.preheader}</div>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto;">
      <!-- header -->
      <tr>
        <td style="padding: 8px 4px 20px 4px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td style="font-family: ${MONO}; font-size: 11px; letter-spacing: 4px; color: #39c5bb; text-transform: uppercase;">
                PROTOCOL::01
              </td>
              <td align="right" style="font-family: ${MONO}; font-size: 11px; letter-spacing: 2px; color: #555560;">
                SYS//WAITLIST
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- main card -->
      <tr>
        <td style="background: #0a0a0c; border: 1px solid #2a2a30; border-top: 2px solid #39c5bb;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <!-- terminal status strip -->
            <tr>
              <td style="padding: 14px 28px; border-bottom: 1px solid #1c1c22; font-family: ${MONO}; font-size: 11px; letter-spacing: 2px;">
                <span style="color: #555560;">&gt; STATUS ::</span>
                <span style="color: #ffcc00;">&nbsp;AWAITING_CONFIRMATION</span>
              </td>
            </tr>

            <!-- content -->
            <tr>
              <td style="padding: 32px 28px 8px 28px;">
                <h1 style="margin: 0 0 6px 0; font-family: ${SANS}; font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: 0.5px;">
                  Protocol <span style="color: #39c5bb;">01</span>
                </h1>
                <p style="margin: 0 0 24px 0; font-family: ${MONO}; font-size: 12px; color: #555560; letter-spacing: 1px;">
                  Privacy-First Payments on Solana
                </p>

                <h2 style="margin: 0 0 12px 0; font-family: ${SANS}; font-size: 20px; font-weight: 700; color: #39c5bb;">
                  ${copy.heading}
                </h2>
                <p style="margin: 0 0 28px 0; font-family: ${SANS}; font-size: 15px; line-height: 1.7; color: #b8b8c0;">
                  ${copy.body}
                </p>
              </td>
            </tr>

            <!-- bulletproof CTA button -->
            <tr>
              <td align="center" style="padding: 0 28px 12px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td bgcolor="#39c5bb" style="border: 1px solid #39c5bb;">
                      <a href="${confirmUrl}"
                         style="display: inline-block; padding: 16px 44px; font-family: ${SANS}; font-size: 14px; font-weight: 800; letter-spacing: 2.5px; text-transform: uppercase; color: #0a0a0c; text-decoration: none;">
                        ${copy.button}
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- raw link fallback -->
            <tr>
              <td style="padding: 8px 28px 28px 28px;">
                <p style="margin: 16px 0 6px 0; font-family: ${SANS}; font-size: 12px; color: #555560;">
                  ${copy.linkHelp}
                </p>
                <p style="margin: 0; font-family: ${MONO}; font-size: 11px; line-height: 1.6; word-break: break-all;">
                  <a href="${confirmUrl}" style="color: #39c5bb; text-decoration: none;">${confirmUrl}</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- disclaimer -->
      <tr>
        <td style="padding: 20px 8px 0 8px; text-align: center;">
          <p style="margin: 0; font-family: ${SANS}; font-size: 12px; line-height: 1.7; color: #555560;">
            ${copy.disclaimer} ${copy.ignore}
          </p>
        </td>
      </tr>

      <!-- footer -->
      <tr>
        <td style="padding: 24px 8px 8px 8px; text-align: center;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td style="border-top: 1px solid #1c1c22; padding-top: 20px; text-align: center;">
                <p style="margin: 0 0 4px 0; font-family: ${MONO}; font-size: 10px; letter-spacing: 2px; color: #3a3a42;">
                  PROTOCOL 01 // © 2026 VOLTA TEAM
                </p>
                <p style="margin: 0 0 12px 0; font-family: ${MONO}; font-size: 10px; letter-spacing: 2px; color: #3a3a42;">
                  TRACE::NULL &nbsp;·&nbsp; LEAK::NONE
                </p>
                <p style="margin: 0;">
                  <a href="${unsubscribeUrl}" style="font-family: ${SANS}; color: #ff2d7a; font-size: 12px; text-decoration: none;">
                    ${copy.unsubscribe}
                  </a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>
  `;
}

/** Plain-text part: raw URLs, no tracking rewrites, better spam score. */
function renderText(copy: Copy, confirmUrl: string, unsubscribeUrl: string): string {
  return [
    'PROTOCOL::01 // WAITLIST',
    '',
    copy.heading,
    '',
    copy.body,
    '',
    `${copy.button}: ${confirmUrl}`,
    '',
    `${copy.disclaimer} ${copy.ignore}`,
    '',
    '--',
    'Protocol 01 - Privacy-First Payments on Solana',
    '© 2026 Volta Team',
    `${copy.unsubscribe}: ${unsubscribeUrl}`,
    '',
  ].join('\n');
}

/**
 * Copy overrides for the single 24h reminder. Everything not listed here
 * (link help, disclaimer, unsubscribe label) is inherited from COPY.
 */
const REMINDER_COPY: Record<Locale, Pick<Copy, 'subject' | 'preheader' | 'heading' | 'body'>> = {
  en: {
    subject: 'Your spot on the Protocol 01 waitlist is still open',
    preheader: 'One click left to lock your spot. This is the only reminder.',
    heading: 'Still there?',
    body: 'You asked for a spot on the Protocol 01 waitlist but your email was never confirmed. One click and it is locked. This is the only reminder we will send.',
  },
  fr: {
    subject: 'Votre place sur la liste d’attente Protocol 01 attend toujours',
    preheader: 'Un clic pour réserver votre place. C’est le seul rappel.',
    heading: 'Toujours là ?',
    body: 'Vous avez demandé une place sur la liste d’attente Protocol 01 mais votre e-mail n’a jamais été confirmé. Un clic et elle est réservée. C’est le seul rappel que nous enverrons.',
  },
  ja: {
    subject: 'Protocol 01 ウェイトリストの確認がまだ完了していません',
    preheader: 'ワンクリックで登録が完了します。リマインダーは今回限りです。',
    heading: 'まだ間に合います',
    body: 'Protocol 01 のウェイトリストにご登録いただきましたが、メールアドレスの確認がまだ完了していません。ワンクリックで登録が確定します。このリマインダーは今回限りです。',
  },
};

async function sendWaitlistEmail(
  copy: Copy,
  params: { email: string; token: string },
): Promise<boolean> {
  const client = getResend();
  if (!client) return false;

  const confirmUrl = `${SITE_URL}/api/waitlist/confirm?token=${params.token}`;
  const unsubscribeUrl = `${SITE_URL}/api/waitlist/unsubscribe?token=${params.token}`;

  try {
    const { error } = await client.emails.send({
      from: emailFrom(),
      to: params.email,
      subject: copy.subject,
      html: renderHtml(copy, confirmUrl, unsubscribeUrl),
      text: renderText(copy, confirmUrl, unsubscribeUrl),
    });
    if (error) {
      console.error('[waitlist] Resend returned an error:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[waitlist] Failed to send waitlist email:', err);
    return false;
  }
}

/**
 * Send the double opt-in confirmation email. Returns true on a successful send,
 * false when Resend is not configured or the send throws. Callers treat false
 * as a mail failure but keep the stored signup either way.
 */
export function sendConfirmationEmail(params: {
  email: string;
  token: string;
  locale: Locale;
}): Promise<boolean> {
  return sendWaitlistEmail(COPY[params.locale], params);
}

/** Send the one-and-only 24h reminder for a still-pending signup. */
export function sendReminderEmail(params: {
  email: string;
  token: string;
  locale: Locale;
}): Promise<boolean> {
  const copy: Copy = { ...COPY[params.locale], ...REMINDER_COPY[params.locale] };
  return sendWaitlistEmail(copy, params);
}
