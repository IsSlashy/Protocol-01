import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { Resend } from 'resend';

// Keys for KV storage
const WHITELIST_KEY = 'whitelist:data';

// Lazy initialize Resend (avoid build-time errors)
let resend: Resend | null = null;
function getResend() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

// Send approval email to developer
async function sendApprovalEmail(email: string, wallet: string, projectName?: string) {
  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 're_YOUR_API_KEY_HERE') {
    return;
  }

  const resendClient = getResend();
  if (!resendClient) return;

  try {
    await resendClient.emails.send({
      from: process.env.EMAIL_FROM || 'Protocol 01 <onboarding@resend.dev>',
      to: email,
      subject: '✅ Protocol 01 - Developer Access Approved!',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #0a0a0c; color: #ffffff;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #39c5bb; font-size: 28px; margin: 0;">Protocol 01</h1>
            <p style="color: #888; margin-top: 8px;">Developer Access</p>
          </div>

          <div style="background: #151518; border: 1px solid #2a2a30; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
            <h2 style="color: #39c5bb; font-size: 20px; margin: 0 0 16px 0;">🎉 You're Approved!</h2>
            <p style="color: #ccc; line-height: 1.6; margin: 0 0 16px 0;">
              Your developer access request has been approved. You can now use the Stream Payments SDK with your wallet.
            </p>

            <div style="background: #0a0a0c; border: 1px solid #39c5bb33; border-radius: 8px; padding: 16px; margin-top: 16px;">
              <p style="color: #888; font-size: 12px; margin: 0 0 4px 0;">Approved Wallet</p>
              <p style="color: #39c5bb; font-family: monospace; font-size: 14px; margin: 0; word-break: break-all;">${wallet}</p>
            </div>

            ${projectName ? `
            <div style="background: #0a0a0c; border: 1px solid #2a2a30; border-radius: 8px; padding: 16px; margin-top: 12px;">
              <p style="color: #888; font-size: 12px; margin: 0 0 4px 0;">Project</p>
              <p style="color: #fff; font-size: 14px; margin: 0;">${projectName}</p>
            </div>
            ` : ''}
          </div>

          <div style="text-align: center;">
            <a href="https://protocol-01.vercel.app/sdk-demo" style="display: inline-block; background: #39c5bb; color: #0a0a0c; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">
              Access SDK Documentation
            </a>
          </div>

          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #2a2a30; text-align: center;">
            <p style="color: #555; font-size: 12px; margin: 0;">
              Protocol 01 - Privacy-First Payments on Solana<br>
              © 2026 Volta Team
            </p>
          </div>
        </div>
      `,
    });
  } catch (error) {
    console.error('Failed to send approval email:', error);
  }
}

// Send Discord notification for approval
async function sendApprovalDiscord(wallet: string, email?: string, projectName?: string) {
  const webhookUrl = process.env.DISCORD_WEBHOOK;
  if (!webhookUrl) {
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: '✅ Developer Access Approved',
          color: 0x39c5bb,
          fields: [
            { name: 'Wallet', value: `\`${wallet}\``, inline: false },
            { name: 'Email', value: email || 'N/A', inline: true },
            { name: 'Project', value: projectName || 'N/A', inline: true },
          ],
          footer: { text: 'Protocol 01 Admin' },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (error) {
    console.error('Failed to send Discord notification:', error);
  }
}

interface WhitelistEntry {
  wallet: string;
  email?: string;
  projectName?: string;
  approvedAt: string;
  approvedBy: string;
}

interface WhitelistData {
  approved: WhitelistEntry[];
  pending: WhitelistEntry[];
}

// Read whitelist from KV
async function readWhitelist(): Promise<WhitelistData> {
  try {
    const data = await kv.get<WhitelistData>(WHITELIST_KEY);
    return data || { approved: [], pending: [] };
  } catch (error) {
    console.error('KV read error:', error);
    return { approved: [], pending: [] };
  }
}

// Write whitelist to KV
async function writeWhitelist(data: WhitelistData): Promise<void> {
  try {
    await kv.set(WHITELIST_KEY, data);
  } catch (error) {
    console.error('KV write error:', error);
    throw error;
  }
}

// GET - Check if wallet is whitelisted or get all entries (admin)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get('wallet');
  const admin = searchParams.get('admin');
  const password = request.headers.get('x-admin-password');

  const whitelist = await readWhitelist();

  // Check single wallet
  if (wallet) {
    const isApproved = whitelist.approved.some(
      (entry) => entry.wallet.toLowerCase() === wallet.toLowerCase()
    );
    return NextResponse.json({ approved: isApproved });
  }

  // Admin: get all entries
  if (admin === 'true') {
    if (password !== process.env.ADMIN_PASSWORD) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json(whitelist);
  }

  // Public: just return approved wallet addresses
  return NextResponse.json({
    approved: whitelist.approved.map((e) => e.wallet),
  });
}

// POST - Add to whitelist
export async function POST(request: NextRequest) {
  const password = request.headers.get('x-admin-password');

  try {
    const body = await request.json();
    const { wallet, email, projectName, action } = body;

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    const whitelist = await readWhitelist();

    // Admin actions require password
    if (action === 'approve') {
      if (password !== process.env.ADMIN_PASSWORD) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const exists = whitelist.approved.some(
        (e) => e.wallet.toLowerCase() === wallet.toLowerCase()
      );

      if (!exists) {
        const pendingEntry = whitelist.pending.find(
          (e) => e.wallet.toLowerCase() === wallet.toLowerCase()
        );
        const developerEmail = email || pendingEntry?.email;
        const developerProject = projectName || pendingEntry?.projectName;

        whitelist.approved.push({
          wallet: wallet.trim(),
          email: developerEmail || undefined,
          projectName: developerProject || undefined,
          approvedAt: new Date().toISOString(),
          approvedBy: 'admin',
        });

        whitelist.pending = whitelist.pending.filter(
          (e) => e.wallet.toLowerCase() !== wallet.toLowerCase()
        );

        await writeWhitelist(whitelist);

        // Send notifications
        if (developerEmail) {
          sendApprovalEmail(developerEmail, wallet.trim(), developerProject);
        }
        sendApprovalDiscord(wallet.trim(), developerEmail, developerProject);
      }

      return NextResponse.json({ success: true, message: 'Wallet approved' });
    }

    if (action === 'reject' || action === 'revoke') {
      if (password !== process.env.ADMIN_PASSWORD) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      whitelist.approved = whitelist.approved.filter(
        (e) => e.wallet.toLowerCase() !== wallet.toLowerCase()
      );
      whitelist.pending = whitelist.pending.filter(
        (e) => e.wallet.toLowerCase() !== wallet.toLowerCase()
      );

      await writeWhitelist(whitelist);

      return NextResponse.json({ success: true, message: 'Wallet removed' });
    }

    // Default: add to pending (public access)
    const existsInPending = whitelist.pending.some(
      (e) => e.wallet.toLowerCase() === wallet.toLowerCase()
    );
    const existsInApproved = whitelist.approved.some(
      (e) => e.wallet.toLowerCase() === wallet.toLowerCase()
    );

    if (!existsInPending && !existsInApproved) {
      whitelist.pending.push({
        wallet: wallet.trim(),
        email: email || undefined,
        projectName: projectName || undefined,
        approvedAt: new Date().toISOString(),
        approvedBy: '',
      });
      await writeWhitelist(whitelist);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Whitelist API error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// DELETE - Remove from whitelist (admin only)
export async function DELETE(request: NextRequest) {
  const password = request.headers.get('x-admin-password');

  if (password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    const whitelist = await readWhitelist();

    whitelist.approved = whitelist.approved.filter(
      (e) => e.wallet.toLowerCase() !== wallet.toLowerCase()
    );
    whitelist.pending = whitelist.pending.filter(
      (e) => e.wallet.toLowerCase() !== wallet.toLowerCase()
    );

    await writeWhitelist(whitelist);

    return NextResponse.json({ success: true, message: 'Wallet removed' });
  } catch (error) {
    console.error('Whitelist API error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
