import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import Home from '@/app/page';
import en from '@/i18n/en';
import fr from '@/i18n/fr';
import { vi } from 'vitest';

vi.mock('@/components/pay/PayApp', () => ({
  default: () => <div data-testid="pay-app-stub">pay app</div>,
}));
vi.mock('@/components/WalletProvider', () => ({
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/**
 * Updated on 2026-08-11 for the Styx Protocol rebrand of `/`.
 *
 * What changed in the page, and therefore here:
 *  - components/SiteHeader.tsx and components/Footer.tsx are gone from this
 *    route. app/_styx/StyxShell.tsx renders StyxHeader and StyxFooter instead,
 *    so the wordmark, the nav destinations and the social links all moved.
 *  - `fixed top-0` is no longer in the markup. `.styx-header` in
 *    app/_styx/styx.css carries position:fixed;top:0, and jsdom does not apply
 *    that stylesheet, so the class name is what a test can observe.
 *  - hero.protocolActive ("Protocol Active"), footer.tagline ("The system cannot
 *    see you") and ecosystem.quantumSafeField ("Quantum-Safe Field") are not
 *    rendered any more. The first two were status theatre and a claim about
 *    being unseen; the third was a chip that claimed more than the page can
 *    stand behind. The assertions on them are replaced by assertions on the copy
 *    that took their place, not deleted.
 *
 * Nothing here was loosened to make it pass: every rewritten assertion names a
 * concrete element, href or dictionary value.
 */
describe('Homepage, the Styx Protocol landing page', () => {
  beforeEach(() => {
    render(<Home />);
  });

  describe('Navigation Bar', () => {
    it('renders the site header at the top, wrapping the nav', () => {
      // The bar is still a <header> wrapping the <nav>, and it is still fixed to
      // the top. The positioning moved from Tailwind classes into `.styx-header`
      // (app/_styx/styx.css), which also reserves the 4rem of space on `.styx`.
      const nav = screen.getByRole('navigation');
      expect(nav).toBeInTheDocument();
      const header = nav.closest('header');
      expect(header).not.toBeNull();
      expect(header!.className).toContain('styx-header');
    });

    it('displays the Styx wordmark linking home in the site header', () => {
      // Was an <img alt="Protocol 01"> pointing at /icon.png. The Styx bar sets
      // a typographic wordmark instead: "Styx" in the serif, "Protocol" in mono.
      const header = screen.getByRole('navigation').closest('header')!;
      const home = within(header).getByRole('link', {
        name: 'Styx Protocol, home',
      });
      expect(home).toHaveAttribute('href', '/');
      expect(within(home).getByText('Styx')).toBeInTheDocument();
      expect(within(home).getByText('Protocol')).toBeInTheDocument();
    });

    it('does not display the retired "PROTOCOL 01" wordmark anywhere', () => {
      // The rename is cosmetic in the code and total in the chrome: no header or
      // footer on this route carries the old wordmark.
      expect(screen.queryByText('PROTOCOL 01')).toBeNull();
    });

    it('exposes exactly the six section links in the nav, in order', () => {
      // Replaces the "Features -> #features" assertion. The anchor nav is gone:
      // the shared bar links to whole routes, and #features is still on this
      // page (asserted under Page Sections) for components/Footer.tsx and for
      // the hero button.
      const nav = screen.getByRole('navigation');
      const links = within(nav).getAllByRole('link');
      expect(links.map((l) => l.getAttribute('href'))).toEqual([
        '/docs',
        '/roadmap',
        '/sdk-demo',
        '/careers',
        '/waitlist',
        '/founder',
      ]);
      expect(links.map((l) => l.textContent)).toEqual([
        'Docs',
        'Roadmap',
        'SDK',
        'Careers',
        'Waitlist',
        'Founder',
      ]);
    });

    it('has a "Try Now" navigation link pointing to /app', () => {
      const navLinks = screen.getAllByText('Try Now');
      const appNavLink = navLinks.find(
        el => el.closest('a')?.getAttribute('href') === '/app'
      );
      expect(appNavLink).toBeDefined();
    });

    it('has an "SDK" navigation link pointing to /sdk-demo', () => {
      // The label shortened from "SDK Demo" to "SDK" in the Styx bar; the
      // destination did not move.
      const sdkLinks = screen.getAllByText('SDK');
      const sdkNavLink = sdkLinks.find(
        el => el.closest('a')?.getAttribute('href') === '/sdk-demo'
      );
      expect(sdkNavLink).toBeDefined();
    });

    it('has a "Docs" navigation link pointing to /docs', () => {
      const link = screen.getByRole('link', { name: 'Docs' });
      expect(link).toHaveAttribute('href', '/docs');
    });

    it('has a "Roadmap" navigation link pointing to /roadmap', () => {
      const links = screen.getAllByRole('link', { name: 'Roadmap' });
      const roadmapLink = links.find(l => l.getAttribute('href') === '/roadmap');
      expect(roadmapLink).toBeDefined();
    });

    it('keeps the live-network pulse as the only route to /explorer', () => {
      const explorer = screen.getByRole('link', { name: en.nav.live });
      expect(explorer).toHaveAttribute('href', '/explorer');
      expect(explorer).toHaveAttribute('title', en.nav.explorer);
    });
  });

  describe('Social Links', () => {
    // The socials moved out of the nav: StyxHeader carries destinations and one
    // CTA, StyxFooter carries X and Discord as named links in its Project
    // column. There are no aria-label-only icon links left on this route.
    it('links to X from the footer', () => {
      const x = screen.getByRole('link', { name: 'X' });
      expect(x).toHaveAttribute('href', 'https://x.com/Styx_PQ');
      expect(x).toHaveAttribute('target', '_blank');
      expect(x).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('links to Discord from the footer (the invitation section left with the long page, 2026-09-12)', () => {
      const footerDiscord = screen.getByRole('link', { name: 'Discord' });
      expect(footerDiscord).toHaveAttribute(
        'href',
        'https://discord.gg/EfqnVmb2dV'
      );
      expect(footerDiscord).toHaveAttribute('target', '_blank');
      expect(screen.queryByRole('link', { name: en.cta.joinDiscord })).toBeNull();
    });

    it('exposes exactly Discord and X as outbound links, GitHub stays hidden in waitlist mode', () => {
      // WAITLIST MODE (app/_styx/StyxFooter.tsx): the GitHub entry is commented
      // out behind "GitHub de-emphasized while access runs through the waitlist,
      // restore at launch". There is no GitHub link anywhere on this page today.
      // When that comment is un-commented, add github.com back to this list.
      const external = screen
        .getAllByRole('link')
        .map(l => l.getAttribute('href') ?? '')
        .filter(href => href.startsWith('http'));
      const hosts = [...new Set(external.map(href => new URL(href).host))].sort();
      expect(hosts).toEqual(['discord.gg', 'x.com']);
    });
  });

  describe('Page Sections', () => {
    // 2026-09-12: the landing page IS the product. One headline, the devnet
    // app, three links. The long sections (problem, features, technology,
    // logos, film, waitlist) are gone from this route; their copy stays in the
    // dictionary and in app/_home/HomeSections.tsx, which nothing renders.
    it('leads with the app headline and one line under it', () => {
      expect(screen.getByRole('heading', { level: 1, name: en.pay.page.h1 })).toBeInTheDocument();
      expect(screen.getByText(en.pay.page.overline)).toBeInTheDocument();
      expect(screen.getByText(`${en.hero.desc3} ${en.hero.desc4}`)).toBeInTheDocument();
    });
    it('renders the devnet app itself, with the devnet line under it', () => {
      const app = document.getElementById('app');
      expect(app).toBeTruthy();
      expect(within(app!).getByTestId('pay-app-stub')).toBeInTheDocument();
      expect(within(app!).getByText(en.pay.page.devnetTag)).toBeInTheDocument();
      expect(within(app!).getByText(en.homeSimple.devnetShort)).toBeInTheDocument();
    });
    it('offers exactly three doors out: docs, SDK, roadmap', () => {
      const links = screen.getByRole('region', { name: en.homeSimple.linksLabel });
      const anchors = within(links).getAllByRole('link');
      expect(anchors.map((a) => a.getAttribute('href'))).toEqual(['/docs', '/sdk-demo', '/roadmap']);
      expect(within(links).getByText(en.homeSimple.docsLine)).toBeInTheDocument();
      expect(within(links).getByText(en.homeSimple.sdkLine)).toBeInTheDocument();
      expect(within(links).getByText(en.homeSimple.roadmapLine)).toBeInTheDocument();
    });
    it('no longer renders the long sections', () => {
      for (const id of ['problem', 'features', 'download', 'tech']) {
        expect(document.getElementById(id)).toBeNull();
      }
      expect(screen.queryByText(en.hero.kicker)).toBeNull();
      expect(screen.queryByText(en.problem.without)).toBeNull();
      expect(screen.queryByText(en.features.privacyPools)).toBeNull();
      expect(screen.queryByText(en.ecosystem.badge)).toBeNull();
    });
    it('renders the Footer, with its devnet warning and the discreet waitlist admin entrance', () => {
      expect(
        screen.getByText(
          'Devnet software. Not audited. Use funds you can afford to lose.'
        )
      ).toBeInTheDocument();
      expect(screen.queryByText(/The system cannot see you/)).toBeNull();
      const admin = screen.getByRole('link', { name: 'Waitlist admin' });
      expect(admin).toHaveAttribute('href', '/admin/waitlist');
    });
  });

  describe('Copy comes from the dictionary', () => {
    it('says the same thing in both locales, with no retired brand and no claim the app page does not make', () => {
      for (const d of [en, fr]) {
        expect(d.pay.page.h1.length).toBeGreaterThan(0);
        expect(d.homeSimple.docsLine).not.toMatch(/protocol[\s-]?01/i);
        expect(d.homeSimple.sdkLine).not.toMatch(/protocol[\s-]?01/i);
        expect(d.homeSimple.roadmapLine).not.toMatch(/protocol[\s-]?01/i);
        for (const line of [d.homeSimple.docsLine, d.homeSimple.sdkLine, d.homeSimple.roadmapLine, d.pay.page.h1]) {
          expect(line).not.toMatch(/zero[\s-]?knowledge|untraceable|trustless|128[\s-]?bit/i);
        }
      }
    });
  });

  describe('App Button in Navigation', () => {
    it('has a prominent "Try Now" CTA button in the nav, opening the app', () => {
      const appButtons = screen.getAllByRole('link', { name: 'Try Now' });
      const ctaButton = appButtons.find(
        el => el.getAttribute('href') === '/app' && el.className.includes('styx-btn')
      );
      expect(ctaButton).toBeDefined();
    });

    // The nav no longer carries a separate "Pay" link: the CTA button above is
    // the only route into the app from this bar.
    it('has no "Pay" nav link competing with it', () => {
      expect(screen.queryByRole('link', { name: 'Pay' })).toBeNull();
    });
  });
});
