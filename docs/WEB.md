# Protocol 01 Web Application

## Overview

The Protocol 01 web application serves as the main landing page, documentation hub, and SDK demonstration platform. Built with Next.js 14, it showcases the Protocol 01 ecosystem and provides developers with interactive examples.

## Features

### Landing Page
- Product showcase
- Feature highlights
- Interactive demos
- Download links
- Social proof

### SDK Demo
- Live wallet connection
- Payment testing
- Stream creation demo
- Devnet tools

### Documentation
- Getting started guides
- API reference
- Integration examples
- Best practices

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: TailwindCSS
- **Animations**: Framer Motion
- **Icons**: Lucide React
- **Deployment**: Vercel

## Project Structure

```
web/
├── app/
│   ├── page.tsx           # Landing page
│   ├── sdk-demo/          # SDK demo page
│   ├── docs/              # Documentation pages
│   └── layout.tsx         # Root layout
├── components/
│   ├── landing/           # Landing page components
│   ├── demo/              # SDK demo components
│   └── ui/                # Shared UI components
├── lib/
│   └── utils.ts           # Utility functions
└── public/
    └── assets/            # Static assets
```

## Development

### Setup

```bash
cd apps/web
pnpm install
pnpm dev
```

### Building

```bash
pnpm build
pnpm start
```

### Environment Variables

```env
NEXT_PUBLIC_SOLANA_RPC=https://api.devnet.solana.com
NEXT_PUBLIC_NETWORK=devnet
```

## Pages

### Landing Page (`/`)

The main marketing page featuring:
- Hero section with animated logo
- Feature grid
- Product showcase (extension, mobile, SDK)
- Call-to-action buttons
- Footer with links

### SDK Demo (`/sdk-demo`)

Interactive demonstration page:
- Wallet connection button
- Balance display
- Send payment form
- Stream creation form
- Devnet faucet integration
- Live transaction results

### Documentation (`/docs`)

Comprehensive documentation:
- Quick start guide
- Installation instructions
- API reference
- Code examples
- FAQ

## Components

### Hero Section
```tsx
<Hero
  title="Protocol 01"
  subtitle="The Privacy-First Solana Wallet"
  cta={{ text: "Get Started", href: "/sdk-demo" }}
/>
```

### Feature Card
```tsx
<FeatureCard
  icon={Shield}
  title="Privacy First"
  description="Stealth addresses and encrypted transactions"
/>
```

### SDK Demo Panel
```tsx
<SDKDemo
  network="devnet"
  showFaucet={true}
/>
```

## Deployment

### Vercel (Recommended)

1. Connect GitHub repository to Vercel
2. Configure environment variables
3. Deploy automatically on push

### Self-Hosted

```bash
pnpm build
pnpm start
# Or with PM2
pm2 start npm --name "p01-web" -- start
```

## SEO

The web app includes:
- Meta tags for social sharing
- Open Graph images
- Structured data
- Sitemap generation
- robots.txt

## Analytics

Planned integrations:
- Vercel Analytics
- Privacy-respecting analytics (Plausible)
- Conversion tracking

## Performance

Optimizations:
- Static generation where possible
- Image optimization with next/image
- Font optimization
- Code splitting
- Edge caching

## Accessibility

- Semantic HTML
- ARIA labels
- Keyboard navigation
- Color contrast compliance
- Screen reader support

## Contributing

1. Fork the repository
2. Create feature branch
3. Make changes
4. Test locally
5. Submit pull request

## Support

- GitHub Issues
- Discord Community
