import { describe, it, expect } from 'vitest';
import type { ModelProfile } from '@warmdrift/kgauto-compiler';
import { runCheck, DESTINATION_SENTENCE, type EngineOptions } from '../src/engine.js';
import type { Extract } from '../src/extract.js';
import { READ } from './helpers/read.js';

/** Minimal fixture profile — lowering/recovery are irrelevant to the engine. */
function mkProfile(over: Partial<ModelProfile> & { id: string }): ModelProfile {
  return {
    provider: 'anthropic',
    status: 'current',
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    maxTools: 64,
    parallelToolCalls: true,
    structuredOutput: 'native',
    systemPromptMode: 'system_param',
    streaming: true,
    cliffs: [],
    costInputPer1m: 3,
    costOutputPer1m: 15,
    lowering: {} as ModelProfile['lowering'],
    recovery: [],
    strengths: [],
    weaknesses: [],
    ...over,
  } as ModelProfile;
}

const ROSTER: ModelProfile[] = [
  mkProfile({ id: 'good-model', verifiedAgainstDocs: '2026-10-01' }),
  mkProfile({ id: 'unstamped-model' }),
  mkProfile({ id: 'old-model', status: 'legacy', verifiedAgainstDocs: '2026-07-25' }),
  mkProfile({
    id: 'seq-model',
    provider: 'deepseek',
    parallelToolCalls: false,
    structuredOutput: 'none',
    costInputPer1m: 0.44,
    costOutputPer1m: 1.32,
  }),
  mkProfile({
    id: 'cliff-model',
    provider: 'google',
    costInputPer1m: 0.1,
    costOutputPer1m: 0.4,
    cliffs: [
      {
        metric: 'input_tokens',
        threshold: 8_000,
        action: 'downgrade_quality_warning',
        whenIntent: 'summarize',
        reason: 'fixture: quality degrades above 8K context on summarize',
      },
    ],
  }),
];

const opts: EngineOptions = {
  resolve: (id) => {
    const canonical = id === 'alias-model' ? 'good-model' : id;
    return { canonical, profile: ROSTER.find((p) => p.id === canonical) };
  },
  roster: () => ROSTER,
};

function extract(sites: Extract['callSites']): Extract {
  return { project: { name: 'test-app' }, callSites: sites };
}

const titles = (r: ReturnType<typeof runCheck>) => r.findings.map((f) => f.title).join('\n');

describe('runCheck — certain-tier catalog facts', () => {
  // 0.4.0 (R2): kgauto's routing status is not the provider's word — a
  // status-legacy profile with no providerLifecycle gets no lifecycle line.
  it('kgauto status legacy alone prints no lifecycle claim', () => {
    const r = runCheck(extract([{ id: 's1', model: 'old-model' }]), opts);
    expect(titles(r)).not.toMatch(/legacy/i);
  });

  // 0.4.0 (R4): the "compat alias … silently serves" line is gone; a kgauto
  // alias is checked as its canonical profile.
  it('a kgauto alias is checked as its canonical and prints no alias claim', () => {
    const r = runCheck(extract([{ id: 's1', model: 'alias-model', retry: 'none' }]), opts);
    expect(titles(r)).not.toContain('compat alias');
    expect(titles(r)).toContain('no second model and no retry found');
  });

  it('parallel-tool reliance on a sequential model is a kgauto measurement: likely, never certain', () => {
    const r = runCheck(
      extract([{ id: 's1', model: 'seq-model', usesParallelToolCalls: true, toolCount: 5 }]),
      opts,
    );
    const f = r.findings.find((x) => x.title.includes('tool calls one at a time'));
    expect(f?.confidence).toBe('likely');
  });

  it('structured-output expectation on a none-capability model is red', () => {
    const r = runCheck(
      extract([{ id: 's1', model: 'seq-model', expectsStructuredOutput: true }]),
      opts,
    );
    expect(titles(r)).toContain('no structured-output support');
  });

  // 0.4.3 (R1): a catalog limit is Likely in every run — its page is not read at run time (until 0.4.2: certain when dated).
  it('worst-case input over the context window is red + likely, with the day the catalog was dated; typical-only and undated are likely too', () => {
    const certain = runCheck(
      extract([{ id: 's1', model: 'good-model', maxInputTokens: 300_000 }]),
      { ...opts, pages: READ },
    ).findings.find((f) => f.title.includes('context window'));
    expect(certain?.severity).toBe('red');
    expect(certain?.confidence).toBe('likely');
    expect(certain?.basis).toMatch(/verified against the provider's page \d{4}-\d{2}-\d{2}/);

    const likely = runCheck(
      extract([{ id: 's1', model: 'good-model', estInputTokens: 300_000 }]),
      opts,
    ).findings.find((f) => f.title.includes('context window'));
    expect(likely?.confidence).toBe('likely');

    const unstamped = runCheck(
      extract([{ id: 's1', model: 'unstamped-model', maxInputTokens: 300_000 }]),
      opts,
    ).findings.find((f) => f.title.includes('context window'));
    expect(unstamped?.confidence).toBe('likely');
  });

  it('no-fallback says what was read, at tier likely (Amendment B, ruling 6)', () => {
    const r = runCheck(extract([{ id: 's1', model: 'good-model', retry: 'none' }]), opts);
    const f = r.findings.find((x) => x.title.includes('no second model and no retry found'));
    expect(f?.confidence).toBe('likely');
  });
});

describe('runCheck — cliffs', () => {
  it('fires when the estimate crosses the threshold on the matching archetype', () => {
    const r = runCheck(
      extract([{ id: 's1', model: 'cliff-model', archetype: 'summarize', estInputTokens: 9_000, estOutputTokens: 200 }]),
      opts,
    );
    const f = r.findings.find((x) => x.title.includes('cliff'));
    expect(f).toBeDefined();
    expect(f?.confidence).toBe('likely');
  });

  it('a whenIntent cliff stays silent on a different archetype', () => {
    const r = runCheck(
      extract([{ id: 's1', model: 'cliff-model', archetype: 'classify', estInputTokens: 9_000 }]),
      opts,
    );
    expect(titles(r)).not.toContain('cliff');
  });
});

describe('runCheck — cost tier', () => {
  it('prices a call from estimates × catalog and projects monthly at volume', () => {
    const r = runCheck(
      extract([
        { id: 's1', model: 'good-model', estInputTokens: 10_000, estOutputTokens: 1_000, estCallsPerMonth: 1_000 },
      ]),
      opts,
    );
    // 10k/1M*3 + 1k/1M*15 = 0.03 + 0.015 = $0.045
    const f = r.findings.find((x) => x.title.includes('/call'));
    expect(f?.title).toContain('$0.0450');
    expect(f?.title).toContain('$45.00/month');
    expect(f?.confidence).toBe('likely');
  });

  it('flags >85% input share as the leak signal', () => {
    const r = runCheck(
      extract([{ id: 's1', model: 'good-model', estInputTokens: 95_000, estOutputTokens: 1_000 }]),
      opts,
    );
    expect(titles(r)).toContain('% of this site');
  });

  it('cheaper candidates are strictly measurable-only and never claim quality', () => {
    const r = runCheck(
      extract([
        { id: 's1', model: 'good-model', archetype: 'summarize', estInputTokens: 10_000, estOutputTokens: 1_000 },
      ]),
      opts,
    );
    const f = r.findings.find((x) => x.title.includes('price under half'));
    expect(f?.confidence).toBe('measurable-only');
    expect(f?.detail).toContain('never');
    expect(f?.detail).not.toMatch(/will hold|is as good/i);
  });
});

describe('runCheck — honesty on unknowns', () => {
  it('an unknown model gets an honest miss and all other checks skip that site', () => {
    const r = runCheck(
      extract([{ id: 's1', model: 'mystery-9000', expectsStructuredOutput: true, retry: 'none' }]),
      opts,
    );
    expect(titles(r)).toContain('was not recognised');
    // structured-output / resilience checks must NOT fire without a profile
    expect(titles(r)).not.toContain('no structured-output support');
    expect(titles(r)).not.toContain('no second model');
  });

  it('the standing measurable-only block is always present', () => {
    const r = runCheck(extract([{ id: 's1', model: 'good-model' }]), opts);
    const f = r.findings.find((x) => x.title.includes('code read cannot tell you'));
    expect(f?.confidence).toBe('measurable-only');
    expect(f?.callSites).toEqual(['s1']);
  });
});

describe('renderCard', () => {
  it('groups tiers in certain → likely → measurable-only order and ends on the destination sentence', () => {
    const r = runCheck(
      extract([
        { id: 's0', model: 'claude-sonnet-4-20250514', platform: 'provider-api' },
        { id: 's1', model: 'good-model', archetype: 'summarize', estInputTokens: 10_000, estOutputTokens: 1_000 },
      ]),
      { ...opts, pages: READ },
    );
    const iCertain = r.card.indexOf('## Certain');
    const iLikely = r.card.indexOf('## Likely');
    const iMeasurable = r.card.indexOf('## Only measurable');
    expect(iCertain).toBeGreaterThan(-1);
    expect(iLikely).toBeGreaterThan(iCertain);
    expect(iMeasurable).toBeGreaterThan(iLikely);
    // 0.4.3 (R2): the footer says what this run read
    expect(r.card).toContain('It read 10 of 10 provider pages in this run');
  });
});

describe('cross-site dedupe (second dogfood catch, playbacksam 2026-08-25)', () => {
  it('one model on many sites yields ONE finding listing every site', () => {
    const r = runCheck(
      extract([
        { id: 's1', model: 'old-model', retry: 'none' },
        { id: 's2', model: 'old-model', retry: 'none' },
        { id: 's3', model: 'old-model', retry: 'none' },
      ]),
      opts,
    );
    const legacy = r.findings.filter((f) => f.title.includes('no second model'));
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.callSites).toEqual(['s1', 's2', 's3']);
  });

  it('distinct titles (different $ amounts) do not merge', () => {
    const r = runCheck(
      extract([
        { id: 's1', model: 'good-model', estInputTokens: 10_000, estOutputTokens: 1_000 },
        { id: 's2', model: 'good-model', estInputTokens: 20_000, estOutputTokens: 1_000 },
      ]),
      opts,
    );
    expect(r.findings.filter((f) => f.title.includes('/call'))).toHaveLength(2);
  });
});

describe('zero-token sites (first dogfood catch, playbacksam 2026-08-25)', () => {
  // The PB extract legitimately reported estInputTokens: 0 for ASR call
  // sites; the schema's positive() rejected the whole extract and the cost
  // block would have emitted a $0.0000/call line with a NaN input share.
  it('the schema accepts zero-token estimates', async () => {
    const { ExtractSchema } = await import('../src/extract.js');
    const parsed = ExtractSchema.safeParse(
      extract([{ id: 's1', model: 'good-model', estInputTokens: 0, estOutputTokens: 0 }]),
    );
    expect(parsed.success).toBe(true);
  });

  it('the cost tier stays silent on a zero-token site (no $0 line, no NaN share)', () => {
    const r = runCheck(
      extract([{ id: 's1', model: 'good-model', estInputTokens: 0, estOutputTokens: 0 }]),
      opts,
    );
    expect(titles(r)).not.toContain('/call');
    expect(titles(r)).not.toContain('% of this site');
  });
});

describe('real bundled roster (integration)', () => {
  it('runs without options against the real catalog and stays honest on a fake id', () => {
    const r = runCheck(extract([{ id: 's1', model: 'not-a-real-model-xyz' }]));
    expect(titles(r)).toContain('was not recognised');
    // 0.4.3 (R1/R2): with no read passed, the footer says no provider page was read
    expect(r.card).toContain('This check ran on your machine and read no provider page in this run');
    expect(DESTINATION_SENTENCE).toMatch(/nothing about your project leaves it unless you choose to share the result/);
    // the not-recognised line is about the lookup itself: Certain with or without a read
    expect(r.findings.find((f) => f.title.includes('was not recognised'))?.confidence).toBe('certain');
    expect(r.catalogVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
