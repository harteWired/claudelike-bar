import { describe, it, expect } from 'vitest';
import { getDefaultColor, getThemeColor, THEME_CSS_VARS } from '../src/types';

describe('getDefaultColor', () => {
  it('returns white for unknown project names', () => {
    expect(getDefaultColor('anything')).toBe('white');
  });

  it('returns white for empty string', () => {
    expect(getDefaultColor('')).toBe('white');
  });
});

describe('getThemeColor', () => {
  it('returns white CSS var for unknown project with no override', () => {
    expect(getThemeColor('unknown')).toBe(THEME_CSS_VARS.white);
  });

  it('uses color override when provided', () => {
    expect(getThemeColor('unknown', 'cyan')).toBe(THEME_CSS_VARS.cyan);
  });

  it('supports red override (not a ThemeGroup, but in COLOR_OVERRIDE_CSS)', () => {
    expect(getThemeColor('unknown', 'red')).toBe('var(--vscode-terminal-ansiRed)');
  });

  it('ignores invalid override and falls back to default', () => {
    expect(getThemeColor('unknown', 'neon-pink')).toBe(THEME_CSS_VARS.white);
  });

  it('passes through hex color values', () => {
    expect(getThemeColor('unknown', '#e06c75')).toBe('#e06c75');
  });

  it('passes through 3-digit hex', () => {
    expect(getThemeColor('unknown', '#f00')).toBe('#f00');
  });

  it('passes through 8-digit hex (with alpha)', () => {
    expect(getThemeColor('unknown', '#e06c75cc')).toBe('#e06c75cc');
  });

  it('passes through rgb()', () => {
    expect(getThemeColor('unknown', 'rgb(224, 108, 117)')).toBe('rgb(224, 108, 117)');
  });

  it('passes through rgba()', () => {
    expect(getThemeColor('unknown', 'rgba(224, 108, 117, 0.8)')).toBe('rgba(224, 108, 117, 0.8)');
  });

  it('passes through hsl()', () => {
    expect(getThemeColor('unknown', 'hsl(355, 65%, 65%)')).toBe('hsl(355, 65%, 65%)');
  });

  it('passes through var() custom properties', () => {
    expect(getThemeColor('unknown', 'var(--my-custom-color)')).toBe('var(--my-custom-color)');
  });

  it('rejects non-CSS strings', () => {
    expect(getThemeColor('unknown', 'alert(1)')).toBe(THEME_CSS_VARS.white);
    expect(getThemeColor('unknown', 'url(evil)')).toBe(THEME_CSS_VARS.white);
  });
});
