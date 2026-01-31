import { describe, it, expect } from 'vitest';

// ============================================================
// Design Token Imports
// ============================================================
import {
  colors,
  getModuleColor,
  getStatusColor,
} from './colors';
import { gradients } from './colors';
import {
  fontFamilies,
  fontSizes,
  fontWeights,
  lineHeights,
  letterSpacings,
  textStyles,
} from './typography';
import {
  spacing,
  semanticSpacing,
  radii,
  borderWidths,
  zIndices,
  breakpoints,
  mediaQueries,
  sizes,
} from './spacing';
import {
  durations,
  easings,
  keyframes,
  animations,
  transitions,
  rnAnimationConfig,
} from './animations';
import {
  shadows,
  glows,
  textGlows,
  borderGlows,
  glass,
  getModuleGlow,
  getStatusGlow,
} from './shadows';

// ============================================================
// Regex patterns for color format validation
// ============================================================
const HEX_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGBA_REGEX = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/;
const COLOR_REGEX = /^(#([0-9a-fA-F]{3,8})|rgba?\(.*\)|transparent)$/;

function isValidColor(value: string): boolean {
  return COLOR_REGEX.test(value) || value === 'transparent';
}

// ============================================================
// Colors
// ============================================================
describe('Colors', () => {
  it('should export a colors object with keys', () => {
    expect(colors).toBeDefined();
    expect(typeof colors).toBe('object');
    expect(Object.keys(colors).length).toBeGreaterThan(0);
  });

  it('every color value should be a valid hex, rgba, or "transparent"', () => {
    for (const [key, value] of Object.entries(colors)) {
      expect(isValidColor(value), `colors.${key} = "${value}" is not a valid color`).toBe(true);
    }
  });

  describe('background colors', () => {
    it('should have void, dark, surface, surface2, and elevated', () => {
      expect(colors.void).toMatch(HEX_REGEX);
      expect(colors.dark).toMatch(HEX_REGEX);
      expect(colors.surface).toMatch(HEX_REGEX);
      expect(colors.surface2).toMatch(HEX_REGEX);
      expect(colors.elevated).toMatch(HEX_REGEX);
    });
  });

  describe('primary cyan colors', () => {
    it('should have cyan, cyanDim, cyanBright as hex', () => {
      expect(colors.cyan).toMatch(HEX_REGEX);
      expect(colors.cyanDim).toMatch(HEX_REGEX);
      expect(colors.cyanBright).toMatch(HEX_REGEX);
    });

    it('should have cyanGlow variants as rgba', () => {
      expect(colors.cyanGlow).toMatch(RGBA_REGEX);
      expect(colors.cyanGlow2).toMatch(RGBA_REGEX);
      expect(colors.cyanGlow3).toMatch(RGBA_REGEX);
    });
  });

  describe('secondary pink colors', () => {
    it('should have pink, pinkHot, pinkLight as hex', () => {
      expect(colors.pink).toMatch(HEX_REGEX);
      expect(colors.pinkHot).toMatch(HEX_REGEX);
      expect(colors.pinkLight).toMatch(HEX_REGEX);
    });

    it('should have pink glow variants as rgba', () => {
      expect(colors.pinkGlow).toMatch(RGBA_REGEX);
      expect(colors.pinkGlow2).toMatch(RGBA_REGEX);
    });
  });

  describe('accent colors', () => {
    it('should have yellow, red, blue, chrome', () => {
      expect(colors.yellow).toMatch(HEX_REGEX);
      expect(colors.red).toMatch(HEX_REGEX);
      expect(colors.blue).toMatch(HEX_REGEX);
      expect(colors.chrome).toMatch(HEX_REGEX);
    });
  });

  describe('text colors', () => {
    it('should define text hierarchy (no black text rule)', () => {
      expect(colors.text).toBe('#ffffff');
      expect(colors.textSecondary).toMatch(HEX_REGEX);
      expect(colors.textMuted).toMatch(HEX_REGEX);
      expect(colors.textDim).toMatch(HEX_REGEX);
      expect(colors.textDisabled).toMatch(HEX_REGEX);
    });

    it('should NOT contain black (#000000) as a text color', () => {
      expect(colors.text).not.toBe('#000000');
      expect(colors.textSecondary).not.toBe('#000000');
      expect(colors.textMuted).not.toBe('#000000');
      expect(colors.textDim).not.toBe('#000000');
      expect(colors.textDisabled).not.toBe('#000000');
    });
  });

  describe('status colors map to correct semantic values', () => {
    it('should have success mapped to cyan (not green)', () => {
      expect(colors.success).toBe(colors.cyan);
    });

    it('should have error mapped to red', () => {
      expect(colors.error).toBe(colors.red);
    });

    it('should have warning mapped to yellow', () => {
      expect(colors.warning).toBe(colors.yellow);
    });
  });

  describe('module colors', () => {
    it('should have wallet, streams, social, agent colors', () => {
      expect(colors.wallet).toBeDefined();
      expect(colors.streams).toBeDefined();
      expect(colors.social).toBeDefined();
      expect(colors.agent).toBeDefined();
    });

    it('should have corresponding glow variants', () => {
      expect(colors.walletGlow).toMatch(RGBA_REGEX);
      expect(colors.streamsGlow).toMatch(RGBA_REGEX);
      expect(colors.socialGlow).toMatch(RGBA_REGEX);
      expect(colors.agentGlow).toMatch(RGBA_REGEX);
    });
  });

  describe('gradients', () => {
    it('should define gradient arrays with two stops', () => {
      for (const [key, value] of Object.entries(gradients)) {
        expect(value, `gradients.${key}`).toHaveLength(2);
        expect(isValidColor(value[0]), `gradients.${key}[0] invalid`).toBe(true);
        expect(isValidColor(value[1]), `gradients.${key}[1] invalid`).toBe(true);
      }
    });
  });

  describe('getModuleColor', () => {
    it('should return primary and glow for each module', () => {
      const modules = ['wallet', 'streams', 'social', 'agent'] as const;
      for (const mod of modules) {
        const result = getModuleColor(mod);
        expect(result).toHaveProperty('primary');
        expect(result).toHaveProperty('glow');
        expect(result.primary).toBeTruthy();
        expect(result.glow).toBeTruthy();
      }
    });
  });

  describe('getStatusColor', () => {
    it('should return primary, dim, glow for each status', () => {
      const statuses = ['success', 'error', 'warning', 'info'] as const;
      for (const s of statuses) {
        const result = getStatusColor(s);
        expect(result).toHaveProperty('primary');
        expect(result).toHaveProperty('dim');
        expect(result).toHaveProperty('glow');
        expect(result.primary).toBeTruthy();
      }
    });
  });
});

// ============================================================
// Typography
// ============================================================
describe('Typography', () => {
  describe('fontFamilies', () => {
    it('should define sans, mono, and display font stacks', () => {
      expect(typeof fontFamilies.sans).toBe('string');
      expect(typeof fontFamilies.mono).toBe('string');
      expect(typeof fontFamilies.display).toBe('string');
    });

    it('sans should include system fonts as fallbacks', () => {
      expect(fontFamilies.sans).toContain('sans-serif');
    });

    it('mono should include monospace as fallback', () => {
      expect(fontFamilies.mono).toContain('monospace');
    });
  });

  describe('fontSizes', () => {
    it('should have values that increase monotonically', () => {
      const sizeKeys = ['xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl'] as const;
      for (let i = 1; i < sizeKeys.length; i++) {
        const prev = fontSizes[sizeKeys[i - 1]];
        const curr = fontSizes[sizeKeys[i]];
        expect(curr, `fontSizes.${sizeKeys[i]} (${curr}) should be > fontSizes.${sizeKeys[i - 1]} (${prev})`).toBeGreaterThan(prev);
      }
    });

    it('all values should be positive numbers', () => {
      for (const [key, value] of Object.entries(fontSizes)) {
        expect(typeof value, `fontSizes.${key}`).toBe('number');
        expect(value, `fontSizes.${key}`).toBeGreaterThan(0);
      }
    });

    it('base size should be 14', () => {
      expect(fontSizes.base).toBe(14);
    });
  });

  describe('fontWeights', () => {
    it('should define standard weight values as strings', () => {
      const weights = Object.values(fontWeights);
      for (const w of weights) {
        expect(typeof w).toBe('string');
        const num = parseInt(w, 10);
        expect(num).toBeGreaterThanOrEqual(100);
        expect(num).toBeLessThanOrEqual(900);
      }
    });

    it('should have weights in increasing order: thin < light < normal < ... < black', () => {
      const ordered = ['thin', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black'] as const;
      for (let i = 1; i < ordered.length; i++) {
        const prev = parseInt(fontWeights[ordered[i - 1]], 10);
        const curr = parseInt(fontWeights[ordered[i]], 10);
        expect(curr).toBeGreaterThan(prev);
      }
    });
  });

  describe('lineHeights', () => {
    it('all values should be positive numbers', () => {
      for (const [key, value] of Object.entries(lineHeights)) {
        expect(typeof value, `lineHeights.${key}`).toBe('number');
        expect(value, `lineHeights.${key}`).toBeGreaterThan(0);
      }
    });

    it('none should be 1 and loose should be 2', () => {
      expect(lineHeights.none).toBe(1);
      expect(lineHeights.loose).toBe(2);
    });
  });

  describe('letterSpacings', () => {
    it('should have tighter as negative and widest as positive', () => {
      expect(letterSpacings.tighter).toBeLessThan(0);
      expect(letterSpacings.widest).toBeGreaterThan(0);
    });

    it('normal should be 0', () => {
      expect(letterSpacings.normal).toBe(0);
    });
  });

  describe('textStyles', () => {
    const requiredProps = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'];

    it('every text style should have all required properties', () => {
      for (const [styleName, style] of Object.entries(textStyles)) {
        for (const prop of requiredProps) {
          expect(
            (style as Record<string, unknown>)[prop],
            `textStyles.${styleName} is missing "${prop}"`
          ).toBeDefined();
        }
      }
    });

    it('display styles should use the display font family', () => {
      expect(textStyles.displayLarge.fontFamily).toBe(fontFamilies.display);
      expect(textStyles.displayMedium.fontFamily).toBe(fontFamilies.display);
      expect(textStyles.displaySmall.fontFamily).toBe(fontFamilies.display);
    });

    it('code styles should use the mono font family', () => {
      expect(textStyles.code.fontFamily).toBe(fontFamilies.mono);
      expect(textStyles.codeSmall.fontFamily).toBe(fontFamilies.mono);
    });

    it('body styles should use the sans font family', () => {
      expect(textStyles.body.fontFamily).toBe(fontFamilies.sans);
      expect(textStyles.bodySmall.fontFamily).toBe(fontFamilies.sans);
      expect(textStyles.bodyLarge.fontFamily).toBe(fontFamilies.sans);
    });

    it('heading sizes should decrease from h1 to h4', () => {
      expect(textStyles.h1.fontSize).toBeGreaterThan(textStyles.h2.fontSize);
      expect(textStyles.h2.fontSize).toBeGreaterThan(textStyles.h3.fontSize);
      expect(textStyles.h3.fontSize).toBeGreaterThan(textStyles.h4.fontSize);
    });
  });
});

// ============================================================
// Spacing
// ============================================================
describe('Spacing', () => {
  describe('spacing scale', () => {
    it('should define spacing[0] as 0', () => {
      expect(spacing[0]).toBe(0);
    });

    it('should define spacing[1] as 4 (base unit)', () => {
      expect(spacing[1]).toBe(4);
    });

    it('should follow 4px grid: spacing[n] = n * 4 for integer keys', () => {
      const intKeys = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96];
      for (const key of intKeys) {
        expect(
          spacing[key as keyof typeof spacing],
          `spacing[${key}] should be ${key * 4}`
        ).toBe(key * 4);
      }
    });

    it('all values should be non-negative numbers', () => {
      for (const [key, value] of Object.entries(spacing)) {
        expect(typeof value, `spacing[${key}]`).toBe('number');
        expect(value, `spacing[${key}]`).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('semanticSpacing', () => {
    it('should reference values from the spacing scale', () => {
      const spacingValues = new Set(Object.values(spacing));
      for (const [key, value] of Object.entries(semanticSpacing)) {
        expect(
          spacingValues.has(value as number),
          `semanticSpacing.${key} = ${value} should exist in spacing scale`
        ).toBe(true);
      }
    });

    it('component paddings should increase: xs < sm < md < lg < xl', () => {
      expect(semanticSpacing.componentPaddingXs).toBeLessThan(semanticSpacing.componentPaddingSm);
      expect(semanticSpacing.componentPaddingSm).toBeLessThan(semanticSpacing.componentPaddingMd);
      expect(semanticSpacing.componentPaddingMd).toBeLessThan(semanticSpacing.componentPaddingLg);
      expect(semanticSpacing.componentPaddingLg).toBeLessThan(semanticSpacing.componentPaddingXl);
    });

    it('gaps should increase: xs < sm < md < lg < xl < 2xl', () => {
      expect(semanticSpacing.gapXs).toBeLessThan(semanticSpacing.gapSm);
      expect(semanticSpacing.gapSm).toBeLessThan(semanticSpacing.gapMd);
      expect(semanticSpacing.gapMd).toBeLessThan(semanticSpacing.gapLg);
      expect(semanticSpacing.gapLg).toBeLessThan(semanticSpacing.gapXl);
      expect(semanticSpacing.gapXl).toBeLessThan(semanticSpacing.gap2xl);
    });
  });

  describe('radii', () => {
    it('none should be 0 and full should be 9999', () => {
      expect(radii.none).toBe(0);
      expect(radii.full).toBe(9999);
    });

    it('should increase: none < sm < md < lg < xl < 2xl < 3xl', () => {
      expect(radii.sm).toBeGreaterThan(radii.none);
      expect(radii.md).toBeGreaterThan(radii.sm);
      expect(radii.lg).toBeGreaterThan(radii.md);
      expect(radii.xl).toBeGreaterThan(radii.lg);
      expect(radii['2xl']).toBeGreaterThan(radii.xl);
      expect(radii['3xl']).toBeGreaterThan(radii['2xl']);
    });
  });

  describe('borderWidths', () => {
    it('should increase: none < thin < medium < thick', () => {
      expect(borderWidths.none).toBe(0);
      expect(borderWidths.thin).toBeLessThan(borderWidths.medium);
      expect(borderWidths.medium).toBeLessThan(borderWidths.thick);
    });
  });

  describe('zIndices', () => {
    it('should increase in layering order', () => {
      const ordered = ['base', 'dropdown', 'sticky', 'fixed', 'overlay', 'modal', 'popover', 'tooltip', 'toast'] as const;
      for (let i = 1; i < ordered.length; i++) {
        expect(
          zIndices[ordered[i]],
          `zIndices.${ordered[i]} should be > zIndices.${ordered[i - 1]}`
        ).toBeGreaterThan(zIndices[ordered[i - 1]]);
      }
    });

    it('max should be the largest z-index', () => {
      expect(zIndices.max).toBe(9999);
    });
  });

  describe('breakpoints', () => {
    it('should increase: xs < sm < md < lg < xl < 2xl', () => {
      expect(breakpoints.xs).toBeLessThan(breakpoints.sm);
      expect(breakpoints.sm).toBeLessThan(breakpoints.md);
      expect(breakpoints.md).toBeLessThan(breakpoints.lg);
      expect(breakpoints.lg).toBeLessThan(breakpoints.xl);
      expect(breakpoints.xl).toBeLessThan(breakpoints['2xl']);
    });

    it('xs should start at 0', () => {
      expect(breakpoints.xs).toBe(0);
    });
  });

  describe('mediaQueries', () => {
    it('should generate valid @media strings from breakpoints', () => {
      expect(mediaQueries.sm).toBe(`@media (min-width: ${breakpoints.sm}px)`);
      expect(mediaQueries.md).toBe(`@media (min-width: ${breakpoints.md}px)`);
      expect(mediaQueries.lg).toBe(`@media (min-width: ${breakpoints.lg}px)`);
      expect(mediaQueries.xl).toBe(`@media (min-width: ${breakpoints.xl}px)`);
      expect(mediaQueries['2xl']).toBe(`@media (min-width: ${breakpoints['2xl']}px)`);
    });
  });

  describe('sizes', () => {
    it('icon sizes should increase: xs < sm < md < lg < xl < 2xl', () => {
      expect(sizes.iconXs).toBeLessThan(sizes.iconSm);
      expect(sizes.iconSm).toBeLessThan(sizes.iconMd);
      expect(sizes.iconMd).toBeLessThan(sizes.iconLg);
      expect(sizes.iconLg).toBeLessThan(sizes.iconXl);
      expect(sizes.iconXl).toBeLessThan(sizes.icon2xl);
    });

    it('button heights should increase: sm < md < lg < xl', () => {
      expect(sizes.buttonSm).toBeLessThan(sizes.buttonMd);
      expect(sizes.buttonMd).toBeLessThan(sizes.buttonLg);
      expect(sizes.buttonLg).toBeLessThan(sizes.buttonXl);
    });

    it('container widths should increase: sm < md < lg < xl < 2xl', () => {
      expect(sizes.containerSm).toBeLessThan(sizes.containerMd);
      expect(sizes.containerMd).toBeLessThan(sizes.containerLg);
      expect(sizes.containerLg).toBeLessThan(sizes.containerXl);
      expect(sizes.containerXl).toBeLessThan(sizes.container2xl);
    });

    it('all size values should be positive numbers', () => {
      for (const [key, value] of Object.entries(sizes)) {
        expect(typeof value, `sizes.${key}`).toBe('number');
        expect(value, `sizes.${key}`).toBeGreaterThan(0);
      }
    });
  });
});

// ============================================================
// Animations
// ============================================================
describe('Animations', () => {
  describe('durations', () => {
    it('instant should be 0', () => {
      expect(durations.instant).toBe(0);
    });

    it('should increase from fastest to glacial', () => {
      const ordered = ['instant', 'fastest', 'faster', 'fast', 'normal', 'slow', 'slower', 'slowest', 'lazy', 'glacial'] as const;
      for (let i = 1; i < ordered.length; i++) {
        expect(durations[ordered[i]]).toBeGreaterThan(durations[ordered[i - 1]]);
      }
    });

    it('all values should be non-negative numbers', () => {
      for (const [key, value] of Object.entries(durations)) {
        expect(typeof value, `durations.${key}`).toBe('number');
        expect(value, `durations.${key}`).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('easings', () => {
    it('should define standard CSS easing keywords', () => {
      expect(easings.linear).toBe('linear');
      expect(easings.ease).toBe('ease');
      expect(easings.easeIn).toBe('ease-in');
      expect(easings.easeOut).toBe('ease-out');
      expect(easings.easeInOut).toBe('ease-in-out');
    });

    it('custom easings should be valid cubic-bezier strings', () => {
      const cubicBezierRegex = /^cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\)$/;
      const customKeys = [
        'easeInQuad', 'easeOutQuad', 'easeInOutQuad',
        'easeInCubic', 'easeOutCubic', 'easeInOutCubic',
        'easeInExpo', 'easeOutExpo', 'easeInOutExpo',
        'easeOutBack', 'easeInBack', 'spring',
        'specter', 'specterIn', 'specterOut',
      ] as const;
      for (const key of customKeys) {
        expect(
          easings[key],
          `easings.${key} should be a cubic-bezier`
        ).toMatch(cubicBezierRegex);
      }
    });
  });

  describe('keyframes', () => {
    it('should define keyframe strings containing @keyframes', () => {
      for (const [key, value] of Object.entries(keyframes)) {
        expect(typeof value, `keyframes.${key}`).toBe('string');
        expect(value, `keyframes.${key} should contain @keyframes`).toContain('@keyframes');
      }
    });

    it('should include essential animations: fadeIn, fadeOut, slideUp, spin, pulse', () => {
      expect(keyframes.fadeIn).toContain('@keyframes fadeIn');
      expect(keyframes.fadeOut).toContain('@keyframes fadeOut');
      expect(keyframes.slideUp).toContain('@keyframes slideUp');
      expect(keyframes.spin).toContain('@keyframes spin');
      expect(keyframes.pulse).toContain('@keyframes pulse');
    });
  });

  describe('animations', () => {
    it('all animation values should be non-empty strings', () => {
      for (const [key, value] of Object.entries(animations)) {
        expect(typeof value, `animations.${key}`).toBe('string');
        expect(value.length, `animations.${key} should not be empty`).toBeGreaterThan(0);
      }
    });

    it('spin animation should include "infinite"', () => {
      expect(animations.spin).toContain('infinite');
    });

    it('fadeIn should reference duration and easing', () => {
      expect(animations.fadeIn).toContain(`${durations.normal}ms`);
      expect(animations.fadeIn).toContain(easings.specter);
    });
  });

  describe('transitions', () => {
    it('all transition values should be non-empty strings', () => {
      for (const [key, value] of Object.entries(transitions)) {
        expect(typeof value, `transitions.${key}`).toBe('string');
        expect(value.length, `transitions.${key}`).toBeGreaterThan(0);
      }
    });

    it('all transition should reference the specter easing', () => {
      expect(transitions.all).toContain(easings.specter);
    });
  });

  describe('rnAnimationConfig', () => {
    it('spring configs should have damping, stiffness, and mass', () => {
      for (const [key, config] of Object.entries(rnAnimationConfig.spring)) {
        expect(config, `rnAnimationConfig.spring.${key}`).toHaveProperty('damping');
        expect(config, `rnAnimationConfig.spring.${key}`).toHaveProperty('stiffness');
        expect(config, `rnAnimationConfig.spring.${key}`).toHaveProperty('mass');
        expect(config.damping).toBeGreaterThan(0);
        expect(config.stiffness).toBeGreaterThan(0);
        expect(config.mass).toBeGreaterThan(0);
      }
    });

    it('timing configs should have duration referencing durations scale', () => {
      expect(rnAnimationConfig.timing.fast.duration).toBe(durations.fast);
      expect(rnAnimationConfig.timing.normal.duration).toBe(durations.normal);
      expect(rnAnimationConfig.timing.slow.duration).toBe(durations.slow);
    });
  });
});

// ============================================================
// Shadows and Glows
// ============================================================
describe('Shadows', () => {
  describe('shadows', () => {
    it('none should be the string "none"', () => {
      expect(shadows.none).toBe('none');
    });

    it('all shadow values should be strings', () => {
      for (const [key, value] of Object.entries(shadows)) {
        expect(typeof value, `shadows.${key}`).toBe('string');
      }
    });

    it('non-none shadows should contain rgba', () => {
      const nonNone = Object.entries(shadows).filter(([k]) => k !== 'none');
      for (const [key, value] of nonNone) {
        expect(value, `shadows.${key}`).toContain('rgba');
      }
    });
  });

  describe('glows', () => {
    it('all glow values should be non-empty strings', () => {
      for (const [key, value] of Object.entries(glows)) {
        expect(typeof value, `glows.${key}`).toBe('string');
        expect(value.length, `glows.${key}`).toBeGreaterThan(0);
      }
    });
  });

  describe('textGlows', () => {
    it('all text glow values should be non-empty strings', () => {
      for (const [key, value] of Object.entries(textGlows)) {
        expect(typeof value, `textGlows.${key}`).toBe('string');
        expect(value.length, `textGlows.${key}`).toBeGreaterThan(0);
      }
    });
  });

  describe('borderGlows', () => {
    it('all border glow values should be non-empty strings', () => {
      for (const [key, value] of Object.entries(borderGlows)) {
        expect(typeof value, `borderGlows.${key}`).toBe('string');
        expect(value.length, `borderGlows.${key}`).toBeGreaterThan(0);
      }
    });
  });

  describe('glass', () => {
    it('card should have background, backdropFilter, and border', () => {
      expect(glass.card).toHaveProperty('background');
      expect(glass.card).toHaveProperty('backdropFilter');
      expect(glass.card).toHaveProperty('border');
    });

    it('modal should have boxShadow', () => {
      expect(glass.modal).toHaveProperty('boxShadow');
    });

    it('all glass presets should have background and backdropFilter', () => {
      for (const [key, value] of Object.entries(glass)) {
        expect(value, `glass.${key}`).toHaveProperty('background');
        expect(value, `glass.${key}`).toHaveProperty('backdropFilter');
      }
    });
  });

  describe('getModuleGlow', () => {
    it('should return sm, md, lg glow for each module', () => {
      const modules = ['wallet', 'streams', 'social', 'agent'] as const;
      for (const mod of modules) {
        const result = getModuleGlow(mod);
        expect(result).toHaveProperty('sm');
        expect(result).toHaveProperty('md');
        expect(result).toHaveProperty('lg');
        expect(typeof result.sm).toBe('string');
        expect(typeof result.md).toBe('string');
        expect(typeof result.lg).toBe('string');
      }
    });
  });

  describe('getStatusGlow', () => {
    it('should return a glow string for each status', () => {
      const statuses = ['success', 'error', 'warning', 'info'] as const;
      for (const s of statuses) {
        const result = getStatusGlow(s);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      }
    });
  });
});

// ============================================================
// Re-export integrity: verify that the index barrel exports
// make all tokens accessible.
// ============================================================
describe('Index barrel exports', () => {
  it('should re-export colors', async () => {
    const idx = await import('./index');
    expect(idx.colors).toBeDefined();
    expect(idx.colors.cyan).toBe(colors.cyan);
  });

  it('should re-export typography tokens', async () => {
    const idx = await import('./index');
    expect(idx.fontFamilies).toBeDefined();
    expect(idx.fontSizes).toBeDefined();
    expect(idx.fontWeights).toBeDefined();
    expect(idx.lineHeights).toBeDefined();
    expect(idx.letterSpacings).toBeDefined();
    expect(idx.textStyles).toBeDefined();
  });

  it('should re-export spacing tokens', async () => {
    const idx = await import('./index');
    expect(idx.spacing).toBeDefined();
    expect(idx.semanticSpacing).toBeDefined();
    expect(idx.radii).toBeDefined();
    expect(idx.borderWidths).toBeDefined();
    expect(idx.zIndices).toBeDefined();
    expect(idx.breakpoints).toBeDefined();
    expect(idx.mediaQueries).toBeDefined();
    expect(idx.sizes).toBeDefined();
  });

  it('should re-export shadow tokens', async () => {
    const idx = await import('./index');
    expect(idx.shadows).toBeDefined();
    expect(idx.glows).toBeDefined();
    expect(idx.textGlows).toBeDefined();
    expect(idx.borderGlows).toBeDefined();
    expect(idx.glass).toBeDefined();
    expect(idx.getModuleGlow).toBeDefined();
    expect(idx.getStatusGlow).toBeDefined();
  });

  it('should re-export animation tokens', async () => {
    const idx = await import('./index');
    expect(idx.durations).toBeDefined();
    expect(idx.easings).toBeDefined();
    expect(idx.keyframes).toBeDefined();
    expect(idx.animations).toBeDefined();
    expect(idx.transitions).toBeDefined();
    expect(idx.rnAnimationConfig).toBeDefined();
  });

  it('should re-export theme object', async () => {
    const idx = await import('./index');
    expect(idx.theme).toBeDefined();
    expect(idx.theme.colors).toBe(colors);
    expect(idx.theme.spacing).toBe(spacing);
    expect(idx.theme.shadows).toBe(shadows);
  });
});
