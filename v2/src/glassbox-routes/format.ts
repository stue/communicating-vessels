/**
 * Pure formatting helpers for Glass-Box trace display.
 *
 * Zero deps, no React, no design tokens. Safe to import from any consumer
 * (React component, server route, CLI, Edge worker).
 *
 * Extracted from the alpha.32 tt-intelligence reference component port in
 * alpha.35 so multiple consumer dashboards can render trace data with
 * matching formatting without re-implementing each helper.
 */

import type { TraceHealth } from './types.js';

export function formatAgo(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function shortTraceId(traceId: string): string {
  return traceId.slice(-6);
}

export function formatCost(usd: number | undefined | null): string {
  if (usd === undefined || usd === null || Number.isNaN(usd)) return '—';
  if (usd === 0) return '$0.0000';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function formatMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatOrDash(v: number | string | undefined | null): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'number') return v.toLocaleString();
  return v;
}

export function inputRatioLabel(
  status: TraceHealth['inputRatioStatus'],
): string {
  switch (status) {
    case 'green':
      return 'healthy';
    case 'yellow':
      return 'borderline';
    case 'red':
      return 'input-heavy';
  }
}

export function formatMutation(mutation: string): string {
  const m = /^(.*)-(\d+)-to-(\d+)$/.exec(mutation);
  if (m) {
    return `${m[1]} (${m[2]} → ${m[3]})`;
  }
  return mutation;
}
