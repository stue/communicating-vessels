/**
 * GlassboxTraceCard — server-component-safe React renderer for a single
 * TraceDetail. Stacked-card view (Header / Outcome / Coaching / Shape /
 * What kgauto did / Counterfactuals / Raw expand).
 *
 * Port of the alpha.32 tt-intelligence reference component, promoted to
 * substrate in alpha.35 so PB + IC + any future consumer can mount the
 * same render shape with a one-line import + brand-specific theme prop.
 *
 * Card-skip rules (substrate behavior, NOT styling — preserved verbatim
 * from the alpha.28 design contract):
 *   - Coaching: hidden when no advisories, no section rewrites, no top counterfactual
 *   - Mutations: hidden when mutationsApplied is empty
 *   - Counterfactuals card: hidden when Coaching already surfaced the top CF
 *     (top CF appears as an info-row in Coaching) OR no CFs at all
 *   - Raw expand: hidden when both rawRequest + rawResponse undefined
 *
 * Zero client JS — the raw-expand uses native <details>/<summary>. Safe to
 * render in Next.js App Router server components, Remix loaders, etc.
 *
 * Theming: pass `theme` prop to override the neutral default with your
 * dashboard's design tokens. See `theme.ts` for the GlassboxTheme shape.
 *
 * HealthDot semantic mapping (substrate-correct, may differ from tt-intel's
 * brand-specific original):
 *   - green  → theme.colors.ok       (healthy)
 *   - yellow → theme.colors.warn     (borderline)
 *   - red    → theme.colors.fail     (input-heavy / cache-off / fell-over)
 *   - na     → theme.colors.textFaint (no measurement)
 */

import type { ReactNode } from 'react';
import type {
  AdvisoryRecord,
  TraceCounterfactual,
  TraceDetail,
  TraceHealth,
  TraceSectionRewrite,
} from '../types.js';
import {
  formatAgo,
  formatCost,
  formatMs,
  formatMutation,
  formatOrDash,
  inputRatioLabel,
  shortTraceId,
} from '../format.js';
import { DEFAULT_GLASSBOX_THEME, type GlassboxTheme } from './theme.js';

// ─── card sub-components ──────────────────────────────────────────────────

interface CardProps {
  children: ReactNode;
  title?: string;
  emphasis?: 'default' | 'coaching' | 'mutations' | 'counterfactuals';
  theme: GlassboxTheme;
}

function Card({ children, title, emphasis = 'default', theme }: CardProps) {
  const { colors, fonts } = theme;
  const accentColor =
    emphasis === 'coaching'
      ? colors.warn
      : emphasis === 'counterfactuals'
        ? colors.ok
        : emphasis === 'mutations'
          ? colors.textMuted
          : null;
  return (
    <div
      style={{
        background: colors.cardBg,
        border: `1px solid ${colors.border}`,
        borderLeft: accentColor
          ? `4px solid ${accentColor}`
          : `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: 14,
        marginBottom: 10,
      }}
    >
      {title && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            color: colors.textMuted,
            fontFamily: fonts.sans,
            marginBottom: 8,
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function HealthDot({
  axis,
  status,
  theme,
}: {
  axis: 'input' | 'cache' | 'fallback';
  status: 'green' | 'yellow' | 'red' | 'na';
  theme: GlassboxTheme;
}) {
  const { colors } = theme;
  const color =
    status === 'green'
      ? colors.ok
      : status === 'yellow'
        ? colors.warn
        : status === 'red'
          ? colors.fail
          : colors.textFaint;
  return (
    <span
      title={`${axis}: ${status}`}
      aria-label={`${axis} ${status}`}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        marginRight: 6,
      }}
    />
  );
}

function AdvisoryRow({
  advisory,
  theme,
}: {
  advisory: AdvisoryRecord;
  theme: GlassboxTheme;
}) {
  const { colors, fonts } = theme;
  const color =
    advisory.level === 'critical'
      ? colors.fail
      : advisory.level === 'warn'
        ? colors.warn
        : colors.info;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'baseline',
        padding: '6px 0',
        borderTop: `1px solid ${colors.borderSoft}`,
        fontFamily: fonts.sans,
        fontSize: 13,
      }}
    >
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 11,
          color,
          fontWeight: 600,
          minWidth: 140,
        }}
      >
        {advisory.code}
      </span>
      <span style={{ color: colors.text, flex: 1 }}>{advisory.message}</span>
      {advisory.suggestedAdaptation && (
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 11,
            color: colors.textMuted,
          }}
          title={advisory.suggestedAdaptation.consequence}
        >
          → try {advisory.suggestedAdaptation.parameter}:&nbsp;
          {String(advisory.suggestedAdaptation.value)}
        </span>
      )}
    </div>
  );
}

function SectionRewriteRow({
  rewrite,
  theme,
}: {
  rewrite: TraceSectionRewrite;
  theme: GlassboxTheme;
}) {
  const { colors, fonts } = theme;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'baseline',
        padding: '6px 0',
        borderTop: `1px solid ${colors.borderSoft}`,
        fontFamily: fonts.sans,
        fontSize: 13,
      }}
      title={`${rewrite.rule} · ${rewrite.kind} · ${rewrite.sectionId}`}
    >
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 11,
          color: colors.info,
          fontWeight: 600,
          minWidth: 140,
        }}
      >
        translator-rewrite
      </span>
      <span style={{ color: colors.text, flex: 1 }}>{rewrite.summary}</span>
    </div>
  );
}

function CounterfactualAsAdvisoryRow({
  cf,
  theme,
}: {
  cf: TraceCounterfactual;
  theme: GlassboxTheme;
}) {
  const { colors, fonts } = theme;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'baseline',
        padding: '6px 0',
        borderTop: `1px solid ${colors.borderSoft}`,
        fontFamily: fonts.sans,
        fontSize: 13,
      }}
    >
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 11,
          color: colors.info,
          fontWeight: 600,
          minWidth: 140,
        }}
      >
        cheaper-alternative
      </span>
      <span style={{ color: colors.text, flex: 1 }}>
        <span style={{ fontFamily: fonts.serif, fontWeight: 600, fontSize: 15 }}>
          {cf.modelId}
        </span>{' '}
        would do this for {formatCost(cf.estimatedCostUsd)} (saves{' '}
        {formatCost(cf.savingsUsd)} / {cf.savingsPercent}%)
      </span>
    </div>
  );
}

// ─── individual card renderers ────────────────────────────────────────────

function HeaderRow({
  detail,
  theme,
}: {
  detail: TraceDetail;
  theme: GlassboxTheme;
}) {
  const { colors, fonts } = theme;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          fontFamily: fonts.serif,
          fontWeight: 600,
          fontSize: 22,
          color: colors.text,
        }}
      >
        {detail.archetype}
      </span>
      <span style={{ color: colors.textFaint }}>·</span>
      <span
        style={{
          fontFamily: fonts.sans,
          fontSize: 12,
          color: colors.textMuted,
        }}
      >
        {formatAgo(detail.createdAt)}
      </span>
      <span style={{ color: colors.textFaint }}>·</span>
      <span
        title={detail.traceId}
        style={{
          fontFamily: fonts.mono,
          fontSize: 11,
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 999,
          padding: '2px 10px',
          color: colors.textMuted,
        }}
      >
        {shortTraceId(detail.traceId)}
      </span>
    </div>
  );
}

function OutcomeCard({
  detail,
  theme,
}: {
  detail: TraceDetail;
  theme: GlassboxTheme;
}) {
  const { colors, fonts } = theme;
  const isFail =
    detail.finishReason !== undefined &&
    detail.finishReason !== 'stop' &&
    detail.finishReason !== 'tool_use';
  const statusColor = isFail ? colors.fail : colors.ok;
  const totalLabel =
    detail.totalMs !== undefined ? formatMs(detail.totalMs) : '—';
  const ttftLabel =
    detail.ttftMs !== undefined ? ` · TTFT ${formatMs(detail.ttftMs)}` : '';
  return (
    <Card theme={theme}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 14,
          flexWrap: 'wrap',
          fontFamily: fonts.sans,
          fontSize: 14,
        }}
      >
        <span
          style={{
            color: statusColor,
            fontWeight: 700,
            fontSize: 18,
          }}
        >
          {isFail ? '✗' : '✓'}
        </span>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 13,
            color: colors.text,
            fontWeight: 600,
          }}
        >
          {detail.target}
        </span>
        {detail.keyFingerprint && (
          <span
            title="fingerprint of the key this call was served with (KG-18 step 0) — the same digest the key-health route reports"
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              color: colors.textMuted,
            }}
          >
            {`key ${detail.keyFingerprint}`}
          </span>
        )}
        <span
          style={{
            fontFamily: fonts.serif,
            fontWeight: 600,
            fontSize: 18,
            color: colors.text,
          }}
        >
          {formatCost(detail.estimatedCostUsd)}
        </span>
        <span style={{ color: colors.textMuted, fontSize: 12 }}>
          {totalLabel}
          {ttftLabel}
        </span>
      </div>
      {detail.fellOverFrom && detail.fellOverFrom !== detail.target && (
        <div
          style={{
            marginTop: 6,
            fontFamily: fonts.sans,
            fontSize: 12,
            color: colors.warn,
          }}
        >
          ↑ fell over from{' '}
          <span style={{ fontFamily: fonts.mono }}>{detail.fellOverFrom}</span>
          {detail.fallbackReason && ` (${detail.fallbackReason})`}
          {detail.fallbackClass && (
            <>
              {' · '}
              <span style={{ fontWeight: 600 }}>{detail.fallbackClass}</span>
              {detail.quotaId && (
                <>
                  {' '}
                  <span style={{ fontFamily: fonts.mono }}>{detail.quotaId}</span>
                </>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function CoachingCard({
  detail,
  theme,
}: {
  detail: TraceDetail;
  theme: GlassboxTheme;
}) {
  const advisories = detail.advisories ?? [];
  const sectionRewrites = detail.sectionRewritesApplied ?? [];
  const counterfactuals = detail.counterfactuals ?? [];
  const topCF = counterfactuals[0];
  if (advisories.length === 0 && sectionRewrites.length === 0 && !topCF) {
    return null;
  }
  return (
    <Card title="⚠ Coaching" emphasis="coaching" theme={theme}>
      <div>
        {advisories.map((a, i) => (
          <AdvisoryRow key={`adv-${i}`} advisory={a} theme={theme} />
        ))}
        {sectionRewrites.map((r, i) => (
          <SectionRewriteRow key={`rw-${i}`} rewrite={r} theme={theme} />
        ))}
        {topCF && (
          <CounterfactualAsAdvisoryRow cf={topCF} theme={theme} />
        )}
      </div>
    </Card>
  );
}

function ShapeCard({
  detail,
  theme,
}: {
  detail: TraceDetail;
  theme: GlassboxTheme;
}) {
  const { colors, fonts } = theme;
  const total = detail.tokensIn + detail.tokensOut;
  const ratioPct = total > 0 ? Math.round((detail.tokensIn / total) * 100) : 0;
  const cachingOff =
    detail.historyCacheableTokens > 1000 && detail.cacheReadInputTokens === 0;
  return (
    <Card theme={theme}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            color: colors.textMuted,
            fontFamily: fonts.sans,
          }}
        >
          📊 Shape
        </div>
        <div>
          <HealthDot
            axis="input"
            status={detail.health.inputRatioStatus}
            theme={theme}
          />
          <HealthDot
            axis="cache"
            status={detail.health.cacheStatus}
            theme={theme}
          />
          <HealthDot
            axis="fallback"
            status={detail.health.fallbackStatus}
            theme={theme}
          />
        </div>
      </div>
      <div
        style={{
          fontFamily: fonts.sans,
          fontSize: 13,
          color: colors.text,
          marginBottom: 4,
        }}
      >
        <span style={{ fontFamily: fonts.serif, fontWeight: 600, fontSize: 15 }}>
          {detail.tokensIn.toLocaleString()}
        </span>{' '}
        in ·{' '}
        <span style={{ fontFamily: fonts.serif, fontWeight: 600, fontSize: 15 }}>
          {detail.tokensOut.toLocaleString()}
        </span>{' '}
        out ({ratioPct}% input — {inputRatioLabel(detail.health.inputRatioStatus)})
      </div>
      <div
        style={{
          fontFamily: fonts.sans,
          fontSize: 12,
          color: colors.textMuted,
          marginBottom: 4,
        }}
      >
        {detail.historyCacheableTokens === 0
          ? 'cache: no cacheable history'
          : `cache: ${detail.cacheReadInputTokens.toLocaleString()} / ${detail.historyCacheableTokens.toLocaleString()} of cacheable history${cachingOff ? ' (caching off)' : ''}`}
      </div>
      <div
        style={{
          fontFamily: fonts.sans,
          fontSize: 12,
          color: colors.textMuted,
        }}
      >
        {formatOrDash(detail.toolsCount)} tools ·{' '}
        {formatOrDash(detail.historyDepth)} history msgs · system{' '}
        {detail.systemPromptChars !== undefined
          ? `${detail.systemPromptChars.toLocaleString()} chars`
          : '—'}
      </div>
    </Card>
  );
}

function MutationsCard({
  detail,
  theme,
}: {
  detail: TraceDetail;
  theme: GlassboxTheme;
}) {
  const { colors, fonts } = theme;
  const mutations = detail.mutationsApplied ?? [];
  if (mutations.length === 0) return null;
  return (
    <Card title="📋 What kgauto did" emphasis="mutations" theme={theme}>
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          fontFamily: fonts.sans,
          fontSize: 13,
          color: colors.text,
        }}
      >
        {mutations.map((m, i) => (
          <li
            key={`mut-${i}`}
            style={{
              padding: '4px 0',
              borderTop:
                i === 0 ? 'none' : `1px solid ${colors.borderSoft}`,
              fontFamily: fonts.mono,
              fontSize: 12,
            }}
          >
            {formatMutation(m)}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CounterfactualsCard({
  detail,
  coachingPresent,
  theme,
}: {
  detail: TraceDetail;
  coachingPresent: boolean;
  theme: GlassboxTheme;
}) {
  const { colors, fonts } = theme;
  const cfs = detail.counterfactuals ?? [];
  if (cfs.length === 0) return null;
  if (coachingPresent) return null;
  return (
    <Card title="💰 Cheaper alternatives" emphasis="counterfactuals" theme={theme}>
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          fontFamily: fonts.sans,
          fontSize: 13,
          color: colors.text,
        }}
      >
        {cfs.slice(0, 2).map((cf, i) => {
          const yearlySavings =
            detail.projectedDailyCostUsd !== undefined &&
            detail.estimatedCostUsd > 0
              ? cf.savingsUsd *
                (detail.projectedDailyCostUsd /
                  Math.max(detail.estimatedCostUsd, 1e-9)) *
                365
              : null;
          return (
            <li
              key={`cf-${i}`}
              style={{
                padding: '6px 0',
                borderTop:
                  i === 0 ? 'none' : `1px solid ${colors.borderSoft}`,
              }}
            >
              <span
                style={{
                  fontFamily: fonts.serif,
                  fontWeight: 600,
                  fontSize: 16,
                }}
              >
                {cf.modelId}
              </span>{' '}
              <span style={{ fontFamily: fonts.mono, fontSize: 12 }}>
                {formatCost(cf.estimatedCostUsd)}
              </span>{' '}
              <span style={{ color: colors.textMuted, fontSize: 12 }}>
                (saves {formatCost(cf.savingsUsd)} / {cf.savingsPercent}%
                {yearlySavings !== null
                  ? ` / $${yearlySavings.toFixed(0)}/year at current volume`
                  : ''}
                )
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function RawExpandCard({
  detail,
  theme,
}: {
  detail: TraceDetail;
  theme: GlassboxTheme;
}) {
  const { colors, fonts } = theme;
  if (detail.rawRequest === undefined && detail.rawResponse === undefined) {
    return null;
  }
  return (
    <Card theme={theme}>
      <details>
        <summary
          style={{
            cursor: 'pointer',
            fontFamily: fonts.sans,
            fontSize: 12,
            color: colors.textMuted,
            listStyle: 'none',
          }}
        >
          ▶ Request / Response
        </summary>
        <div style={{ marginTop: 8 }}>
          {detail.rawRequest !== undefined && (
            <>
              <div
                style={{
                  fontFamily: fonts.sans,
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  color: colors.textMuted,
                  marginTop: 6,
                  marginBottom: 4,
                }}
              >
                Request
              </div>
              <pre
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  lineHeight: 1.5,
                  background: colors.surface,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 6,
                  padding: 10,
                  maxHeight: 280,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: colors.text,
                  margin: 0,
                }}
              >
                {detail.rawRequest}
              </pre>
            </>
          )}
          {detail.rawResponse !== undefined && (
            <>
              <div
                style={{
                  fontFamily: fonts.sans,
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  color: colors.textMuted,
                  marginTop: 10,
                  marginBottom: 4,
                }}
              >
                Response
              </div>
              <pre
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  lineHeight: 1.5,
                  background: colors.surface,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 6,
                  padding: 10,
                  maxHeight: 280,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: colors.text,
                  margin: 0,
                }}
              >
                {detail.rawResponse}
              </pre>
            </>
          )}
        </div>
      </details>
    </Card>
  );
}

// ─── top-level render ─────────────────────────────────────────────────────

export interface GlassboxTraceCardProps {
  detail: TraceDetail;
  /**
   * Optional theme override. Defaults to a neutral cool slate palette + system
   * fonts (NOT tt-intelligence's warm brand). Consumer dashboards should pass
   * their own design tokens.
   */
  theme?: GlassboxTheme;
}

/**
 * Render one TraceDetail as a stacked-card view. Server component (no
 * client JS). Cards with empty data hide automatically per the alpha.28
 * design contract.
 */
export function GlassboxTraceCard({
  detail,
  theme = DEFAULT_GLASSBOX_THEME,
}: GlassboxTraceCardProps) {
  const { colors } = theme;
  const advisories = detail.advisories ?? [];
  const sectionRewrites = detail.sectionRewritesApplied ?? [];
  const counterfactuals = detail.counterfactuals ?? [];
  const topCF = counterfactuals[0];
  const coachingPresent =
    advisories.length > 0 || sectionRewrites.length > 0 || !!topCF;

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: 14,
        marginBottom: 16,
      }}
    >
      <div style={{ marginBottom: 10 }}>
        <HeaderRow detail={detail} theme={theme} />
      </div>
      <OutcomeCard detail={detail} theme={theme} />
      {coachingPresent && <CoachingCard detail={detail} theme={theme} />}
      <ShapeCard detail={detail} theme={theme} />
      <MutationsCard detail={detail} theme={theme} />
      <CounterfactualsCard
        detail={detail}
        coachingPresent={coachingPresent}
        theme={theme}
      />
      <RawExpandCard detail={detail} theme={theme} />
    </div>
  );
}
