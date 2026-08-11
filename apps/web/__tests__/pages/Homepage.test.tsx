import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import Home from '@/app/page';
import en from '@/i18n/en';
import fr from '@/i18n/fr';

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
      expect(x).toHaveAttribute('href', 'https://x.com/Protocol01_');
      expect(x).toHaveAttribute('target', '_blank');
      expect(x).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('links to Discord from the footer and from the invitation section', () => {
      const footerDiscord = screen.getByRole('link', { name: 'Discord' });
      expect(footerDiscord).toHaveAttribute(
        'href',
        'https://discord.gg/EfqnVmb2dV'
      );
      expect(footerDiscord).toHaveAttribute('target', '_blank');

      const ctaDiscord = screen.getByRole('link', { name: en.cta.joinDiscord });
      expect(ctaDiscord).toHaveAttribute('href', 'https://discord.gg/EfqnVmb2dV');
      expect(ctaDiscord).toHaveAttribute('target', '_blank');
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
    it('renders the Hero section', () => {
      // Was 'Protocol Active', a status pill deleted with the rebrand. The hero
      // now opens on the kicker and the statement line, both dictionary keys.
      expect(screen.getByText(en.hero.kicker)).toBeInTheDocument();
      expect(screen.getByText(en.hero.desc1)).toBeInTheDocument();
    });

    it('states the devnet-only, unaudited, still-linkable position above the fold', () => {
      // The amber admission is the page's credibility and the reason the two
      // "nothing they can trace" claims could be deleted rather than restyled.
      const admission = screen.getByText(
        en.docs.sections.denominatedPools.desc
      );
      expect(admission).toBeInTheDocument();
      expect(admission.className).toContain('styx-admission-body');
      expect(screen.getByText(en.footer.disclaimer)).toBeInTheDocument();
      // The disclosure is introduced by a heading that reads as one.
      // roadmap.current, the single word "Current", labels a phase on /roadmap
      // and said nothing about what follows it here.
      const title = screen.getByText(en.careers.context.badge);
      expect(title.className).toContain('styx-admission-title');
      expect(screen.queryByText(en.roadmap.current)).toBeNull();
    });

    it('renders the Problem section with id="problem"', () => {
      const problemSection = document.getElementById('problem');
      expect(problemSection).toBeTruthy();
    });

    it('renders the Features section with id="features"', () => {
      const featuresSection = document.getElementById('features');
      expect(featuresSection).toBeTruthy();
    });

    it('renders the technology list in place of the removed id="tech" section', () => {
      // Commit a91974cd ("streamline landing page -- remove tech sections")
      // dropped the TechStack/Showcase sections from the landing page; the
      // technology list moved to /docs and to the Ecosystem marquee. Nothing
      // links to #tech any more, so the anchor is gone on purpose.
      expect(document.getElementById('tech')).toBeNull();
      expect(screen.getByText(en.ecosystem.badge)).toBeInTheDocument();
      // The two title halves render inside one heading, so the assertion is on
      // the whole line rather than on the highlight fragment.
      expect(
        screen.getByText(
          `${en.ecosystem.title} ${en.ecosystem.titleHighlight}`
        )
      ).toBeInTheDocument();
      // The marquee is gone (its keyframes live in app/globals.css), so each
      // technology appears exactly once, with its role beside it.
      expect(screen.getByText('Winterfell')).toBeInTheDocument();
      expect(screen.getByText(en.ecosystem.starkProver)).toBeInTheDocument();
      // "Quantum-Safe Field" and "Quantum-Safe Proofs" were marquee chips that
      // claimed more than the measured fact. Deleted with the marquee.
      expect(screen.queryByText(en.ecosystem.quantumSafeField)).toBeNull();
      expect(screen.queryByText(en.ecosystem.quantumSafeProofs)).toBeNull();
    });

    it('renders the CTA/Download section with id="download"', () => {
      const downloadSection = document.getElementById('download');
      expect(downloadSection).toBeTruthy();
    });

    it('renders the Footer, with its devnet warning and the discreet waitlist admin entrance', () => {
      // Was footer.tagline, "> The system cannot see you.", which the rebrand
      // does not publish. StyxFooter states the position instead, and keeps the
      // founder's only link into /admin/waitlist.
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
    // The port's first pass wrote about thirty-five sentences straight into the
    // JSX, which reads correctly in English and silently serves English to a
    // French visitor, because a literal has no fr.ts entry behind it. These
    // assertions pin the slots that were hardcoded to the dictionary values they
    // now render, so the regression cannot come back unnoticed.
    it('captions the two ledgers as a matched pair, in both locales, with no retired brand', () => {
      // Section 01 compares two ledgers side by side, so the two captions have
      // to name two ledgers. problem.without and problem.with are the keys
      // written for those two slots, and the assertion is on the pair rather
      // than on one caption at a time, because the defect it replaces was a pair
      // that stopped matching: an earlier pass could not reword the two keys
      // (they read "WITHOUT / WITH PROTOCOL 01") so it borrowed
      // explorer.observer.standardChain for the left slot and
      // explorer.stat.anonSet, a counter label from /explorer, for the right
      // one, and the comparison read "Standard chain" against "Shielded Notes".
      // Both keys carry the pair now, so the brand check moves onto the
      // dictionary values themselves, in both locales, which is where the
      // regression would come back.
      const left = screen.getByText(en.problem.without);
      const right = screen.getByText(en.problem.with);
      expect(left.className).toContain('styx-card-label');
      expect(right.className).toContain('styx-card-label');
      expect(en.problem.without).not.toMatch(/protocol[\s-]?01/i);
      expect(en.problem.with).not.toMatch(/protocol[\s-]?01/i);
      expect(fr.problem.without).not.toMatch(/protocol[\s-]?01/i);
      expect(fr.problem.with).not.toMatch(/protocol[\s-]?01/i);
      // The /explorer counter label is not a caption for half of a comparison.
      expect(screen.queryByText(en.explorer.stat.anonSet)).toBeNull();
    });

    it('closes both ledger cards with a status line, not a specification fragment', () => {
      // The right card used to end on a leader row, "Proof .... post-quantum, no
      // trusted setup", assembled from explorer.observer.proof and
      // explorer.stat.circuitsHint. The left card ends on a sentence, so that
      // row broke the parallel the whole panel is built on.
      expect(screen.getByText(en.problem.exposedStatus)).toBeInTheDocument();
      expect(screen.getByText(en.problem.anonymousStatus)).toBeInTheDocument();
      expect(screen.queryByText(en.explorer.observer.proof)).toBeNull();
      expect(screen.queryByText(en.explorer.stat.circuitsHint)).toBeNull();
    });

    it('scopes the proof-system note to the proof system, with no blanket elliptic-curve claim', () => {
      // The first facts card used to carry explorer.circuits.subtitle, which
      // says "no elliptic curves" and "each operation is verified on-chain by
      // one of these". The first half contradicts the card beside it
      // (X25519 + ML-KEM-768) and three rows of the stack list (Curve25519,
      // Circom, ark-circom); the second is the largest capability claim on the
      // page. docs.sections.zkProofs.detail7 states the measured property, and
      // only about the proof.
      expect(
        screen.getByText(en.docs.sections.zkProofs.detail7)
      ).toBeInTheDocument();
      expect(screen.queryByText(en.explorer.circuits.subtitle)).toBeNull();
      expect(screen.getByText(en.explorer.circuits.title)).toBeInTheDocument();
    });

    it('states the devnet position once in the facts grid, next to the on-device measurement', () => {
      // The fourth card stacked "Devnet Only" over "Beta on Solana Devnet." over
      // "Devnet only, not audited.", and section 03 printed "Devnet Only" a
      // fourth time as a chip. One statement of the position stays, and the
      // note is spent on the measurement nothing else on the page carries.
      expect(screen.getByText(en.footer.copyright)).toBeInTheDocument();
      expect(
        screen.getByText(en.docs.sections.zkProofs.detail5)
      ).toBeInTheDocument();
      expect(screen.queryByText(en.extensionPage.betaTitle)).toBeNull();
      // roadmap.devnetOnly and docs.footerDevnet are both "Devnet Only".
      expect(screen.queryAllByText(en.docs.footerDevnet)).toHaveLength(0);
      expect(screen.queryAllByText(en.roadmap.devnetOnly)).toHaveLength(0);
    });

    it('renders the withdrawal step from the docs sentence, not "zero trace"', () => {
      expect(
        screen.getByText(en.docs.sections.denominatedPools.detail8)
      ).toBeInTheDocument();
      expect(screen.queryByText(en.howItWorks.step4Desc)).toBeNull();
    });

    it('heads the invitation with a dictionary line, not "Ready to become invisible"', () => {
      // The slot is an h2, and its value is reworded rather than borrowed: it
      // used to be "Self-custody, open source, no KYC. Live on devnet.", which
      // is hero.desc3 + hero.desc4 in other words, so the closing section opened
      // by repeating the hero. The heading must not restate the hero lede.
      const heading = screen.getByRole('heading', {
        level: 2,
        name: en.footer.ctaSubtitle,
      });
      expect(heading).toBeInTheDocument();
      // hero.desc3 and hero.desc4 stay in the hero lede, and one of them is not
      // allowed to come back as this heading.
      expect(en.footer.ctaSubtitle).not.toBe(en.hero.desc3);
      expect(en.footer.ctaSubtitle).not.toBe(en.hero.desc4);
      expect(en.footer.ctaSubtitle).not.toBe(
        `${en.hero.desc3} ${en.hero.desc4}`
      );
      expect(screen.queryByText(en.cta.titleHighlight)).toBeNull();
    });

    it('renders the module cards from keys, with no unlinkability claim left', () => {
      expect(screen.getByText(en.features.privacyPools)).toBeInTheDocument();
      expect(
        screen.getByText(en.features.desc.privacyPools)
      ).toBeInTheDocument();
      expect(
        screen.getByText(en.docs.sections.stealthAddresses.desc)
      ).toBeInTheDocument();
      // The four features.desc.* values that promised an absolute the page's own
      // admission contradicts are not rendered anywhere.
      expect(
        screen.queryByText(en.features.desc.stealthMetaAddresses)
      ).toBeNull();
      expect(screen.queryByText(en.features.desc.subscriptionVaults)).toBeNull();
      expect(screen.queryByText(en.features.desc.zkProofs)).toBeNull();
      expect(screen.queryByText(en.features.desc.noteSplitting)).toBeNull();
    });

    it('drops the unbenchmarked timing strip and the zero-traces chip', () => {
      expect(screen.queryByText(en.howItWorks.shieldTime)).toBeNull();
      expect(screen.queryByText(en.howItWorks.instantOps)).toBeNull();
      expect(screen.queryByText(en.howItWorks.zeroTraces)).toBeNull();
      expect(screen.getByText(en.extensionPage.betaBadge)).toBeInTheDocument();
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
