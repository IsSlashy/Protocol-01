import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import TerminalAnimation from '@/components/TerminalAnimation';

// Helper: advance through N timer ticks, flushing React state after each
function advanceSteps(n: number) {
  for (let i = 0; i < n; i++) {
    act(() => {
      vi.advanceTimersByTime(600);
    });
  }
}

describe('TerminalAnimation -- CLI-style protocol demonstration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Terminal Chrome', () => {
    it('renders the terminal with p01-cli title', () => {
      render(<TerminalAnimation />);
      expect(screen.getByText('p01-cli')).toBeInTheDocument();
    });

    it('renders the blinking cursor element', () => {
      const { container } = render(<TerminalAnimation />);
      const cursor = container.querySelector('.bg-p01-cyan');
      expect(cursor).toBeTruthy();
    });

    it('accepts and applies a custom className prop', () => {
      const { container } = render(<TerminalAnimation className="custom-test-class" />);
      const terminal = container.firstElementChild;
      expect(terminal?.className).toContain('custom-test-class');
    });
  });

  describe('Command Sequence Animation', () => {
    it('starts with an empty terminal before animation begins', () => {
      render(<TerminalAnimation />);
      expect(screen.queryByText('$ p01 init --stealth')).not.toBeInTheDocument();
    });

    it('reveals the first command "$ p01 init --stealth" after one tick', () => {
      render(<TerminalAnimation />);
      advanceSteps(1);
      expect(screen.getByText('$ p01 init --stealth')).toBeInTheDocument();
    });

    it('shows initialization output after two ticks', () => {
      render(<TerminalAnimation />);
      advanceSteps(2);
      expect(screen.getByText('Initializing Protocol 01...')).toBeInTheDocument();
    });

    it('shows ZK circuits loaded success message after three ticks', () => {
      render(<TerminalAnimation />);
      advanceSteps(3);
      expect(screen.getByText('[OK] Zero-knowledge circuits loaded')).toBeInTheDocument();
    });

    it('shows stealth address generation success after four ticks', () => {
      render(<TerminalAnimation />);
      advanceSteps(4);
      expect(screen.getByText('[OK] Stealth address generated')).toBeInTheDocument();
    });

    it('shows private relay connection success after five ticks', () => {
      render(<TerminalAnimation />);
      advanceSteps(5);
      expect(screen.getByText('[OK] Private relay connected')).toBeInTheDocument();
    });

    it('reveals all 12 terminal lines after the full sequence', () => {
      render(<TerminalAnimation />);
      advanceSteps(12);
      expect(screen.getByText('$ p01 init --stealth')).toBeInTheDocument();
      expect(screen.getByText('[OK] Wallet created: 0x7f3a...8c2e')).toBeInTheDocument();
      expect(screen.getByText('[OK] Transaction sent (untraceable)')).toBeInTheDocument();
      expect(screen.getByText('>> The system cannot see you.')).toBeInTheDocument();
    });

    it('includes the wallet creation command at step 6', () => {
      render(<TerminalAnimation />);
      advanceSteps(6);
      expect(screen.getByText('$ p01 wallet create --anonymous')).toBeInTheDocument();
    });

    it('includes the private send command at step 9', () => {
      render(<TerminalAnimation />);
      advanceSteps(9);
      expect(screen.getByText('$ p01 send --private 100 USDC')).toBeInTheDocument();
    });
  });

  describe('Animation Loop', () => {
    it('resets the animation 3 seconds after completion for continuous demo', () => {
      render(<TerminalAnimation />);
      // Complete all 12 lines
      advanceSteps(12);
      expect(screen.getByText('>> The system cannot see you.')).toBeInTheDocument();

      // After completion, a 3000ms reset timeout is set
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      // After reset, visibleLines = 0, so lines are cleared
      expect(screen.queryByText('>> The system cannot see you.')).not.toBeInTheDocument();
    });
  });
});
