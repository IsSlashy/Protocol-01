/**
 * Tests for GlitchLogo component
 *
 * The GlitchLogo is the signature branding component of Protocol 01,
 * featuring chromatic aberration and ULTRAKILL-style glitch effects.
 *
 * Validates:
 * - Renders the 01-miku.png logo images (main + color channels)
 * - Displays "PROTOCOL" text when showText is enabled
 * - Respects the size prop for proper popup scaling
 * - Handles the animated=false prop (static mode for inner pages)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import GlitchLogo from './GlitchLogo';

// framer-motion is auto-mocked via src/__mocks__/framer-motion.tsx

describe('GlitchLogo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the main logo image', () => {
    render(<GlitchLogo size={140} />);

    const images = screen.getAllByRole('img');
    expect(images.length).toBeGreaterThanOrEqual(1);

    const mainImg = images.find((img) => img.getAttribute('alt') === 'Protocol 01');
    expect(mainImg).toBeInTheDocument();
  });

  it('renders the chromatic aberration layers (cyan and pink)', () => {
    const { container } = render(<GlitchLogo size={140} />);

    // There are 3 img layers: cyan channel (alt=""), pink channel (alt=""), main image (alt="Protocol 01")
    // Images with alt="" are decorative and hidden from the accessibility tree,
    // so we use querySelectorAll instead of getAllByRole('img')
    const images = container.querySelectorAll('img');
    expect(images.length).toBeGreaterThanOrEqual(3);
  });

  it('displays "PROTOCOL" text when showText is true', () => {
    render(<GlitchLogo size={140} showText={true} />);

    const protocolTexts = screen.getAllByText('PROTOCOL');
    expect(protocolTexts.length).toBeGreaterThanOrEqual(1);
  });

  it('does not display text when showText is false', () => {
    render(<GlitchLogo size={140} showText={false} />);

    expect(screen.queryByText('PROTOCOL')).not.toBeInTheDocument();
  });

  it('respects the size prop for image dimensions', () => {
    const { container } = render(<GlitchLogo size={80} />);

    const images = container.querySelectorAll('img');
    const mainImage = Array.from(images).find(
      (img) => img.getAttribute('alt') === 'Protocol 01',
    );
    expect(mainImage).toBeDefined();
    expect(mainImage?.style.width).toBe('80px');
  });

  it('applies the correct height ratio (0.5x size)', () => {
    const { container } = render(<GlitchLogo size={100} />);

    const images = container.querySelectorAll('img');
    const mainImage = Array.from(images).find(
      (img) => img.getAttribute('alt') === 'Protocol 01',
    );
    // imageHeight = size * 0.5 = 50px
    expect(mainImage?.style.height).toBe('50px');
  });

  it('renders without animation effects when animated is false', () => {
    const { container } = render(
      <GlitchLogo size={60} showText={false} animated={false} />,
    );

    expect(container.querySelector('img')).toBeInTheDocument();
  });
});
