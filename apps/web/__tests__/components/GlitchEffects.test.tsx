import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import GlitchLogo01 from '@/components/GlitchLogo01';
import GlitchText01 from '@/components/GlitchText01';

describe('GlitchLogo01 -- Chromatic aberration logo effect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the main "01" logo image', () => {
    render(<GlitchLogo01 />);
    const images = screen.getAllByRole('img');
    const mainImage = images.find(img => img.getAttribute('alt') === '01');
    expect(mainImage).toBeDefined();
    expect(mainImage).toHaveAttribute('src', '/01-miku.png');
  });

  it('renders cyan chromatic aberration channel', () => {
    const { container } = render(<GlitchLogo01 />);
    const images = container.querySelectorAll('img');
    // Should have 3 base images (cyan, pink, main) + potential slice
    expect(images.length).toBeGreaterThanOrEqual(3);
  });

  it('renders pink chromatic aberration channel', () => {
    const { container } = render(<GlitchLogo01 />);
    const images = container.querySelectorAll('img[src="/01-miku.png"]');
    expect(images.length).toBeGreaterThanOrEqual(3);
  });

  it('uses screen blend mode for color channel separation', () => {
    const { container } = render(<GlitchLogo01 />);
    const blendedImages = container.querySelectorAll('img');
    const hasScreenBlend = Array.from(blendedImages).some(
      img => img.style.mixBlendMode === 'screen'
    );
    expect(hasScreenBlend).toBe(true);
  });

  it('renders with responsive sizing classes for mobile through desktop', () => {
    const { container } = render(<GlitchLogo01 />);
    // The motion.div wrapper has responsive width/height classes
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain('md:w-[400px]');
    expect(wrapper?.className).toContain('lg:w-[500px]');
  });
});

describe('GlitchText01 -- CSS-animated "01" text with glitch effects', () => {
  it('renders multiple "01" text layers for chromatic aberration', () => {
    render(<GlitchText01 />);
    const texts = screen.getAllByText('01');
    // Cyan layer, Pink layer, Main layer, Tear slice 1, Tear slice 2
    expect(texts.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts and applies a custom className prop', () => {
    const { container } = render(<GlitchText01 className="my-custom-class" />);
    expect(container.firstElementChild?.className).toContain('my-custom-class');
  });

  it('renders with the select-none class to prevent text selection', () => {
    const { container } = render(<GlitchText01 />);
    expect(container.firstElementChild?.className).toContain('select-none');
  });

  it('injects CSS keyframe animations for the glitch effect', () => {
    const { container } = render(<GlitchText01 />);
    const styles = container.querySelectorAll('style');
    expect(styles.length).toBeGreaterThanOrEqual(1);
    const styleContent = Array.from(styles).map(s => s.innerHTML).join('');
    expect(styleContent).toContain('t01-chromatic-cyan');
    expect(styleContent).toContain('t01-chromatic-pink');
    expect(styleContent).toContain('t01-shake');
    expect(styleContent).toContain('t01-tear-1');
    expect(styleContent).toContain('t01-glow-pulse');
    expect(styleContent).toContain('t01-flicker');
  });

  it('includes prefers-reduced-motion media query for accessibility', () => {
    const { container } = render(<GlitchText01 />);
    const styles = container.querySelectorAll('style');
    const styleContent = Array.from(styles).map(s => s.innerHTML).join('');
    expect(styleContent).toContain('prefers-reduced-motion');
  });

  it('uses scanline overlay for CRT monitor aesthetic', () => {
    const { container } = render(<GlitchText01 />);
    // Look for repeating-linear-gradient in style attributes (scanlines)
    const allDivs = container.querySelectorAll('div');
    const hasScanlines = Array.from(allDivs).some(
      div => div.style.background?.includes('repeating-linear-gradient')
    );
    expect(hasScanlines).toBe(true);
  });
});
