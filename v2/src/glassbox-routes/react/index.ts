/**
 * Public entry point for `@warmdrift/kgauto-compiler/glassbox-routes/react`.
 *
 * One-line consumer mount:
 *
 *   import { GlassboxTraceCard } from '@warmdrift/kgauto-compiler/glassbox-routes/react';
 *   <GlassboxTraceCard detail={detail} theme={myBrandTheme} />
 *
 * React (>=18) + react-dom are optional peer dependencies — only consumers
 * importing this subpath need them. Server-component-safe: no hooks, no
 * client JS, raw-expand uses native <details>/<summary>.
 *
 * See `./theme.ts` for `GlassboxTheme` shape and `DEFAULT_GLASSBOX_THEME`
 * (neutral cool slate palette + system fonts — override with your brand).
 */

export {
  GlassboxTraceCard,
  type GlassboxTraceCardProps,
} from './GlassboxTraceCard.js';
export {
  DEFAULT_GLASSBOX_THEME,
  type GlassboxTheme,
  type GlassboxThemeColors,
  type GlassboxThemeFonts,
} from './theme.js';
