import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn() -- Tailwind class name merge utility', () => {
  it('merges multiple class names', () => {
    expect(cn('bg-red-500', 'text-white')).toBe('bg-red-500 text-white');
  });

  it('handles conditional classes with clsx syntax', () => {
    const isActive = true;
    expect(cn('base-class', isActive && 'active-class')).toBe('base-class active-class');
  });

  it('filters out falsy values', () => {
    expect(cn('base', false, null, undefined, '', 'end')).toBe('base end');
  });

  it('resolves conflicting Tailwind classes by keeping the last one', () => {
    expect(cn('bg-red-500', 'bg-blue-500')).toBe('bg-blue-500');
  });

  it('resolves conflicting padding classes', () => {
    expect(cn('p-4', 'p-8')).toBe('p-8');
  });

  it('handles array inputs', () => {
    expect(cn(['flex', 'items-center'], 'gap-2')).toBe('flex items-center gap-2');
  });

  it('handles object inputs with clsx syntax', () => {
    expect(cn({ 'font-bold': true, 'text-red-500': false, 'text-cyan-500': true }))
      .toBe('font-bold text-cyan-500');
  });

  it('handles empty input gracefully', () => {
    expect(cn()).toBe('');
  });
});
