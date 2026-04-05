/**
 * Protocol 01 — Content Engine
 *
 * Uses Claude API to generate marketing content for social media.
 * Optimized for the visual-first, developer-focused strategy that
 * gets the most traction on crypto Twitter.
 *
 * Usage: npx ts-node scripts/content-engine.ts [command]
 *
 * Commands:
 *   tweet          — Generate a tweet thread about a P01 feature
 *   visual         — Generate a visual post description (for image generation)
 *   thread         — Generate a technical thread explaining a concept
 *   outreach       — Generate personalized outreach messages (YOU send them manually)
 *   launch-plan    — Generate a 7-day content calendar
 *   pitch          — Generate a pitch variant for a specific audience
 */

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// Protocol 01 context — everything the AI needs to know
const P01_CONTEXT = `
You are a marketing content creator for Protocol 01, a privacy infrastructure SDK for Solana.

KEY FACTS:
- Privacy SDK for Solana — any app can add private transactions in ~10 lines of code
- 16 on-chain programs, 12 ZK circuits (SNARKs + STARKs), quantum-resistant
- 14 SDKs under @protocol-01/ npm scope
- Built by a solo dev (Ramy/Slashy) in 3 months
- Competitor Umbra raised $155M — we built more with $0
- ZK-KYC compliance module (privacy AND regulation)
- Apps built on the SDK: mobile wallet, Chrome extension, web app, Mugen P2P exchange

TONE:
- Technical but accessible — explain complex crypto simply
- Confident, not arrogant — let the tech speak
- Visual-first — every post should pair with an image/diagram idea
- Developer-focused — target Solana builders, wallet teams, DeFi protocols
- No hype language ("revolutionary", "game-changing") — just facts

WHAT PERFORMS BEST (based on real data):
- Generated images + flow diagrams get 5-8x more engagement than text
- "P01 x [Partner]" style announcements with clean visuals get clicks
- Short technical explainers with code snippets
- Before/after comparisons (public tx vs private tx)

AVOID:
- Dev log style posts ("just pushed a commit...")
- Long text-only threads
- Generic crypto hype
- Aggressive calls to action
`;

type Command = 'tweet' | 'visual' | 'thread' | 'outreach' | 'launch-plan' | 'pitch';

const PROMPTS: Record<Command, string> = {
  tweet: `Generate 5 tweet options for Protocol 01. Each tweet should:
- Be under 280 characters
- Include a hook in the first line
- Suggest a visual/image to pair with it (in brackets)
- Include 1-2 relevant hashtags
- Focus on ONE specific feature or benefit

Topics to rotate: SDK simplicity, privacy by default, ZK-KYC compliance, quantum resistance, Solana speed, developer experience.

Format each as:
TWEET #N:
[text]
[Visual: description of image to generate]
[Hashtags]`,

  visual: `Generate 5 visual post concepts for Protocol 01's social media. Each should:
- Describe an image/diagram that can be created with AI image generation (Midjourney/DALL-E)
- Include the text overlay for the image
- Include the caption for the post
- Be designed to stop the scroll (bold, high contrast, dark theme with cyan/pink accents matching P01 brand)

Focus on: architecture diagrams, before/after comparisons, code snippet screenshots, feature announcements, ecosystem maps.

Format each as:
VISUAL #N:
Image prompt: [detailed AI image generation prompt]
Text overlay: [what text goes on the image]
Caption: [the post caption, under 200 chars]`,

  thread: `Generate a 5-tweet technical thread explaining ONE Protocol 01 concept to Solana developers.

Pick from: stealth addresses, shielded pools, ZK-KYC, STARK quantum resistance, or the SDK integration flow.

Requirements:
- Tweet 1: Hook — why should a developer care?
- Tweet 2: The problem it solves
- Tweet 3: How it works (simplified, with a diagram suggestion)
- Tweet 4: Code snippet showing SDK usage (real-looking TypeScript)
- Tweet 5: CTA — try it on devnet + link

Each tweet under 280 chars. Suggest a visual for tweets 1 and 3.`,

  outreach: `Generate 5 personalized outreach message templates for Protocol 01.

Target audiences:
1. Solana wallet developer (Phantom, Backpack, etc.)
2. DeFi protocol builder
3. Crypto VC / angel investor
4. Solana ecosystem influencer / KOL
5. Hackathon teammate candidate

Each message should:
- Be personal, NOT automated-sounding
- Reference something specific about their work (leave [PLACEHOLDER] for personalization)
- Explain the value prop in 1-2 sentences
- Include a soft CTA (not "buy" but "check out" or "would love your feedback")
- Be under 150 words
- Feel like a human developer wrote it, not a bot

These are templates for MANUAL sending. The human will personalize and send each one individually.`,

  'launch-plan': `Create a 7-day content calendar for Protocol 01 leading up to a major event (Entrepreneur Go, Paris, April 15-16).

For each day, provide:
- Morning post (tweet or thread)
- Afternoon post (visual or announcement)
- Evening engagement (reply strategy or community interaction)

Theme each day:
Day 1: The Problem (crypto transparency)
Day 2: The Solution (SDK infrastructure)
Day 3: Technical Deep Dive (pick a feature)
Day 4: Social Proof (what's built, metrics)
Day 5: The Team & Vision
Day 6: Event Hype (we're at Entrepreneur Go)
Day 7: Live from the event

Include visual suggestions for each post.`,

  pitch: `Generate 3 pitch variants for Protocol 01, each targeting a different audience:

1. **For a Solana wallet team** (technical, SDK-focused)
   - Why they should integrate P01 SDK
   - What it gives their users
   - How fast integration is

2. **For a non-technical investor** (business-focused)
   - Market size, competitor validation ($155M raised)
   - Revenue model (SDK licensing + protocol fees)
   - Why now

3. **For a hackathon judge** (impact-focused)
   - Technical innovation
   - Solo dev achievement
   - Real-world impact

Each pitch should be 30 seconds of speaking (about 80-100 words). Include a one-line hook to open with.`,
};

async function run(command: Command, extraContext?: string) {
  const prompt = PROMPTS[command];
  if (!prompt) {
    console.error(`Unknown command: ${command}`);
    console.log('Available commands:', Object.keys(PROMPTS).join(', '));
    process.exit(1);
  }

  console.log(`\n🎯 Generating: ${command}\n${'─'.repeat(50)}\n`);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: `${P01_CONTEXT}\n\n${extraContext ? `ADDITIONAL CONTEXT: ${extraContext}\n\n` : ''}${prompt}`,
      },
    ],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  console.log(text);

  // Show token usage for budget tracking
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Tokens used: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`);

  const cost = (message.usage.input_tokens * 3 / 1_000_000) + (message.usage.output_tokens * 15 / 1_000_000);
  console.log(`💰 Estimated cost: ~$${cost.toFixed(4)}`);
}

// CLI
const command = (process.argv[2] || 'tweet') as Command;
const extraContext = process.argv[3];

run(command, extraContext).catch(console.error);
