/**
 * GlassboxTheme — visual tokens consumed by <GlassboxTraceCard>.
 *
 * Pass via `theme` prop to override the neutral default with your dashboard's
 * design system. All 14 tokens are required; spread the default and override
 * what you need:
 *
 *   import { DEFAULT_GLASSBOX_THEME } from '@warmdrift/kgauto-compiler/glassbox-routes/react';
 *   const myTheme = { ...DEFAULT_GLASSBOX_THEME, colors: { ...DEFAULT_GLASSBOX_THEME.colors, warn: '#C75B7A' } };
 *
 * The default is a deliberately neutral cool slate palette + system fonts —
 * NOT tt-intelligence's warm brand. Consumers should override with their own
 * brand tokens; the substrate stays brand-agnostic.
 */

export interface GlassboxThemeColors {
  /** Page/section background (behind cards). */
  surface: string;
  /** Card / row border. */
  border: string;
  /** Softer border for inner dividers. */
  borderSoft: string;
  /** Card background. */
  cardBg: string;
  /** Primary text. */
  text: string;
  /** Secondary text (labels, metadata). */
  textMuted: string;
  /** Tertiary text (annotations). */
  textFaint: string;
  /** Healthy / success state marker. */
  ok: string;
  /** Warning / borderline / coaching state marker. Reserved for state, not decoration. */
  warn: string;
  /** Failure / error state marker. */
  fail: string;
  /** Informational state marker (advisory link, counterfactual). */
  info: string;
}

export interface GlassboxThemeFonts {
  /** UI sans-serif stack. */
  sans: string;
  /** Display / heading stack. */
  serif: string;
  /** Monospace stack for IDs, traceIds, raw payloads. */
  mono: string;
}

export interface GlassboxTheme {
  colors: GlassboxThemeColors;
  fonts: GlassboxThemeFonts;
}

export const DEFAULT_GLASSBOX_THEME: GlassboxTheme = {
  colors: {
    surface: '#F8FAFC',
    border: '#E2E8F0',
    borderSoft: '#F1F5F9',
    cardBg: '#FFFFFF',
    text: '#1E293B',
    textMuted: '#64748B',
    textFaint: '#94A3B8',
    ok: '#15803D',
    warn: '#B45309',
    fail: '#B91C1C',
    info: '#1D4ED8',
  },
  fonts: {
    sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, Menlo, Consolas, monospace',
  },
};
