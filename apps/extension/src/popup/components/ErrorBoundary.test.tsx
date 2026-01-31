/**
 * Tests for ErrorBoundary component
 *
 * Validates that the global error boundary:
 * - Renders children normally when no errors occur
 * - Catches rendering errors and displays the fallback UI
 * - Shows the error message to aid debugging
 * - Provides a RESET & RELOAD action to recover
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

// Component that throws on render
function ExplodingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Simulated render failure');
  }
  return <div>Child rendered successfully</div>;
}

describe('ErrorBoundary', () => {
  // Suppress React error boundary console output during tests
  const originalError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalError;
  });

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <ExplodingComponent shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Child rendered successfully')).toBeInTheDocument();
  });

  it('renders the error fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <ExplodingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('ERROR')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    expect(screen.getByText('Simulated render failure')).toBeInTheDocument();
  });

  it('displays a generic message for errors without a message', () => {
    function NoMessageError() {
      throw new Error();
    }

    render(
      <ErrorBoundary>
        <NoMessageError />
      </ErrorBoundary>,
    );

    // Should show the "ERROR" heading and "Unknown error" in the details
    expect(screen.getByText('ERROR')).toBeInTheDocument();
    expect(screen.getByText('Unknown error')).toBeInTheDocument();
  });

  it('provides a RESET & RELOAD button that clears localStorage', () => {
    const clearSpy = vi.spyOn(Storage.prototype, 'clear');
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { reload: reloadMock },
      writable: true,
    });

    render(
      <ErrorBoundary>
        <ExplodingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    const resetButton = screen.getByText('RESET & RELOAD');
    expect(resetButton).toBeInTheDocument();

    fireEvent.click(resetButton);

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('applies the correct extension popup dimensions to the error view', () => {
    render(
      <ErrorBoundary>
        <ExplodingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    // The error container uses the fixed popup dimensions w-[360px] h-[600px]
    const errorContainer = screen.getByText('ERROR').closest('div[class*="w-[360px]"]');
    expect(errorContainer).toBeInTheDocument();
  });
});
