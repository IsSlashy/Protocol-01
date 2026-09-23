import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import DepthBackground from '@/components/DepthBackground';

describe('DepthBackground -- Multi-layered cyberpunk atmosphere', () => {
  it('renders without crashing', () => {
    const { container } = render(<DepthBackground />);
    expect(container.firstElementChild).toBeTruthy();
  });

  it('renders the fixed background container', () => {
    const { container } = render(<DepthBackground />);
    const bg = container.firstElementChild;
    expect(bg?.className).toContain('fixed');
    expect(bg?.className).toContain('inset-0');
    expect(bg?.className).toContain('pointer-events-none');
  });

  it('renders floating particles with geometric symbols (+, diamond, circle, etc.)', () => {
    const { container } = render(<DepthBackground />);
    const particles = container.querySelectorAll('span.absolute');
    expect(particles.length).toBe(8);
  });

  it('renders the SVG mesh network with connection lines', () => {
    const { container } = render(<DepthBackground />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    const lines = svg?.querySelectorAll('line');
    expect(lines?.length).toBe(12); // 12 mesh connections
  });

  it('renders mesh network points with CSS pulse animation', () => {
    const { container } = render(<DepthBackground />);
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(9); // 9 mesh points
  });

  it('does not render a scanline effect', () => {
    const { container } = render(<DepthBackground />);
    const scanline = Array.from(container.querySelectorAll('div')).find(
      el => el.style.animation?.includes('scanline-move')
    );
    expect(scanline).toBeFalsy();
  });

  it('injects CSS keyframes for float and shimmer animations', () => {
    const { container } = render(<DepthBackground />);
    const style = container.querySelector('style');
    expect(style).toBeTruthy();
    expect(style?.innerHTML).toContain('float-particle');
    expect(style?.innerHTML).toContain('shimmer');
  });

  it('includes prefers-reduced-motion support for accessibility', () => {
    const { container } = render(<DepthBackground />);
    const style = container.querySelector('style');
    expect(style?.innerHTML).toContain('prefers-reduced-motion');
  });

  it('renders the noise texture overlay for film grain effect', () => {
    const { container } = render(<DepthBackground />);
    // Noise is applied via inline style with SVG data URL.
    // jsdom may not parse background-image consistently, so check the mix-blend-overlay class
    // which is applied only to the noise layer.
    const noiseDiv = container.querySelector('.mix-blend-overlay');
    expect(noiseDiv).toBeTruthy();
  });
});
