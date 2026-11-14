/**
 * The check 0.4.1 (filing 2026-11-14, rulings R1–R9). Every test here was run
 * against the source it replaces first and seen red; the filing's foot says how.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ModelProfile } from '@warmdrift/kgauto-compiler';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
  version: string;
  license: string;
  files: string[];
};

describe('R1 — a cliff line is worded from the cliff', () => {
  const QUALITY = 'quality degrades in a measured, repeatable way';
  type Cliff = ModelProfile['cliffs'][number];
  const fixture = (cliff: Cliff): ModelProfile =>
    ({
      id: 'fx-model',
      provider: 'google',
      status: 'current',
      maxContextTokens: 1_000_000,
      maxOutputTokens: 8_192,
      maxTools: 64,
      parallelToolCalls: true,
      structuredOutput: 'native',
      systemPromptMode: 'system_param',
      streaming: true,
      cliffs: [cliff],
      costInputPer1m: 1,
      costOutputPer1m: 1,
      lowering: {},
      recovery: [],
      strengths: [],
      weaknesses: [],
    }) as unknown as ModelProfile;
  const cliffFinding = async (cliff: Cliff, site: Record<string, unknown> = {}) => {
    const { runCheck } = await import('../src/engine.js');
    const p = fixture(cliff);
    const r = runCheck(
      { project: { name: 't' }, callSites: [{ id: 'a.ts:1', model: 'fx-model', platform: 'provider-api', estInputTokens: 50_000, toolCount: 5, expectsStructuredOutput: true, ...site } as never] },
      { resolve: () => ({ canonical: 'fx-model', profile: p }), roster: () => [p] },
    );
    return r.findings.find((f) => f.title.includes('cliff'));
  };
  const base = { metric: 'input_tokens', threshold: 10_000, reason: 'fixture reason' } as const;

  it('the fresh-eyes line: gpt-6-luna on the real catalog says what the profile says — a refused request on one probe, on one endpoint', async () => {
    const { runCheck } = await import('../src/engine.js');
    const r = runCheck({ project: { name: 't' }, callSites: [{ id: 'cfg.ts:1', model: 'gpt-6-luna', platform: 'provider-api', toolCount: 30 }] });
    const f = r.findings.find((x) => x.title.includes('cliff'))!;
    expect(f.title).toBe('`gpt-6-luna` has a known tool count cliff at 1 — this site crosses it');
    expect(f.confidence).toBe('likely');
    expect(f.detail).not.toContain(QUALITY);
    expect(f.detail).toContain("rejects function tools with reasoning_effort on /v1/chat/completions (HTTP 400, alpha.133 probe 2026-11-12, n=1");
    expect(f.detail).toContain('It is about one endpoint, `/v1/chat/completions`: it says nothing about the model reached another way.');
    expect(f.detail).toContain("What the compiler does about it: it turns the model's thinking off for the request.");
    expect(f.detail).toContain('Evidence: a probe reproduced it, last run 2026-11-12, on 1 call (the count its reason gives).');
    expect(f.detail).toContain('This site offers 30 tools, over the line.');
    expect(f.basis).toBe("the catalog's cliff rule (evidence: probed, confirmed, 2026-11-12) vs this site's tool count");
  });

  it('a pricing-tier rule with no evidence record (gpt-6-astra) is not called a quality loss', async () => {
    const { runCheck } = await import('../src/engine.js');
    const r = runCheck({ project: { name: 't' }, callSites: [{ id: 'cfg.ts:1', model: 'gpt-6-astra', platform: 'provider-api', estInputTokens: 400_000 }] });
    const f = r.findings.find((x) => x.title.includes('cliff'))!;
    expect(f.confidence).toBe('likely');
    expect(f.detail).not.toContain(QUALITY);
    expect(f.detail).toContain('“OpenAI pricing tier shift: >272K input tokens billed at $20/$75');
    expect(f.detail).toContain('What the compiler does about it: it attaches a warning to the compiled request and leaves the request as it is.');
    expect(f.detail).toContain('Evidence: the rule carries no evidence record.');
    expect(f.detail).toContain('Your estimate of 400,000 sits over the line.');
  });

  it('the quality sentence is printed only for a quality action on observed or probe-confirmed evidence', async () => {
    const cases: Array<[Partial<Cliff>, boolean]> = [
      [{ action: 'downgrade_quality_warning', evidence: { class: 'observed' } }, true],
      [{ action: 'downgrade_quality_warning', evidence: { class: 'probed', verdict: 'confirmed', lastProbed: '2026-10-01' } }, true],
      [{ action: 'quality_gate_structured', evidence: { class: 'probed', verdict: 'knee-moved', lastProbed: '2026-10-01' } }, true],
      // Amendment B2: a class derived only from the prose ("measured") no longer carries the sentence.
      [{ action: 'quality_gate_structured', reason: 'parse failures measured on long input, 2026-07-25' }, false],
      [{ action: 'downgrade_quality_warning', evidence: { class: 'probed', verdict: 'flagged', lastProbed: '2026-10-01' } }, false],
      [{ action: 'downgrade_quality_warning', evidence: { class: 'probed' } }, false],
      [{ action: 'downgrade_quality_warning', evidence: { class: 'assumed' } }, false],
      [{ action: 'downgrade_quality_warning', evidence: { class: 'asserted' } }, false],
      [{ action: 'downgrade_quality_warning' }, false],
      [{ action: 'force_thinking_budget_zero', evidence: { class: 'observed' } }, false],
      [{ action: 'escalate_target', evidence: { class: 'probed', verdict: 'confirmed' } }, false],
    ];
    for (const [over, quality] of cases) {
      const f = await cliffFinding({ ...base, ...over } as Cliff);
      expect(f, JSON.stringify(over)).toBeDefined();
      expect(f!.detail.includes(QUALITY), JSON.stringify(over)).toBe(quality);
      expect(f!.confidence).toBe('likely');
    }
  });

  it('the evidence is said in plain words, with its date where the profile gives one', async () => {
    const said = async (over: Partial<Cliff>) => (await cliffFinding({ ...base, action: 'downgrade_quality_warning', ...over } as Cliff))!.detail;
    expect(await said({ evidence: { class: 'probed', verdict: 'flagged', lastProbed: '2026-09-01' } })).toContain('Evidence: a probe did not reproduce it, last run 2026-09-01.');
    expect(await said({ evidence: { class: 'probed', verdict: 'knee-moved', lastProbed: '2026-09-02' } })).toContain(
      'Evidence: a probe moved its threshold and the rule was re-pinned, last run 2026-09-02.',
    );
    expect(await said({ evidence: { class: 'probed' } })).toContain('Evidence: a probe ran; its verdict is not recorded.');
    expect(await said({ evidence: { class: 'observed', lastProbed: '2026-08-01' } })).toContain('Evidence: observed in real calls, last seen 2026-08-01.');
    expect(await said({ evidence: { class: 'assumed' } })).toContain('Evidence: carried over from a similar model, not measured on this one.');
    expect(await said({ evidence: { class: 'asserted' } })).toContain('Evidence: stated in the catalog without a measurement.');
    expect(await said({ reason: 'inherited from the sibling; conservative' })).toContain(
      'Evidence: the rule carries no evidence record; its reason says it is carried over, not measured on this model.',
    );
    expect(await said({ reason: 'empty answers measured on summarize, 5/5' })).toContain(
      "Evidence: no evidence record; the catalog's note describes a measured incident.",
    );
  });

  it('a capability-reducing action the compiler holds back is said as held back', async () => {
    const f = await cliffFinding({ ...base, metric: 'tool_count', threshold: 2, action: 'strip_tools', evidence: { class: 'asserted' } } as Cliff);
    expect(f!.detail).toContain(
      'What the compiler does about it: it would send the request without its tools, but holds that back until a probe confirms the cliff.',
    );
    const g = await cliffFinding({ ...base, metric: 'tool_count', threshold: 2, action: 'strip_tools', evidence: { class: 'probed', verdict: 'confirmed' } } as Cliff);
    expect(g!.detail).toContain('What the compiler does about it: it sends the request without its tools.');
  });

  it('a structured-output rule speaks only where the site parses structured output, as the compiler applies it', async () => {
    const { runCheck } = await import('../src/engine.js');
    const site = { id: 'a.ts:1', model: 'claude-haiku-4-5', platform: 'provider-api', archetype: 'summarize', estInputTokens: 12_000 };
    const cliffOf = (s: object) => runCheck({ project: { name: 't' }, callSites: [s as never] }).findings.find((f) => f.title.includes('cliff'));
    expect(cliffOf(site)).toBeUndefined();
    const f = cliffOf({ ...site, expectsStructuredOutput: true })!;
    // Amendment B2: no evidence record, so no quality sentence.
    expect(f.detail).not.toContain('quality degrades');
    // Amendment A1: this reason names one of our applications, so it is not quoted.
    expect(f.detail).toContain("The catalog's note for this rule is written for our own records and is not quoted.");
    expect(f.detail).toContain("Evidence: no evidence record; the catalog's note describes a measured incident.");
  });

  it('no cliff line is ever certain, on any bundled profile whose cliff a site can cross', async () => {
    const { runCheck } = await import('../src/engine.js');
    const { allProfiles } = await import('@warmdrift/kgauto-compiler');
    let fired = 0;
    for (const p of allProfiles()) {
      for (const c of p.cliffs) {
        if (c.metric !== 'input_tokens' && c.metric !== 'tool_count') continue;
        const site = {
          id: 'x.ts:1',
          model: p.id,
          platform: 'provider-api',
          expectsStructuredOutput: true,
          ...(c.whenIntent ? { archetype: c.whenIntent } : {}),
          ...(c.metric === 'input_tokens' ? { estInputTokens: c.threshold } : { toolCount: c.threshold }),
        };
        const r = runCheck({ project: { name: 't' }, callSites: [site as never] }, {
          resolve: (id) => ({ canonical: id, profile: id === p.id ? p : undefined }),
        });
        const lines = r.findings.filter((f) => f.title.includes(' cliff at '));
        for (const f of lines) {
          fired++;
          expect(f.confidence, `${p.id} ${c.metric}`).toBe('likely');
          expect(f.detail, `${p.id}`).toMatch(/The catalog's reason|The catalog's note for this rule is written for our own records/);
        }
      }
    }
    // 18 bundled cliffs in 2.0.0-alpha.133, 10 on a metric the check reads; a sweep that fires none is not a test.
    expect(fired).toBe(10);
  });
});

describe('Amendment A1 — no internal application’s name on a stranger’s card', () => {
  const RULED = ['playbacksam', 'tt-intel', 'tt-intelligence', 'inspire-central', 'global-expansion', 'lovable-intelligence', 'incantato', 'ivypass'];
  const named = (text: string) => RULED.filter((n) => text.toLowerCase().includes(n));

  it('the check exports the ruled list', async () => {
    const engine = (await import('../src/engine.js')) as Record<string, unknown>;
    expect(engine.INTERNAL_APPS).toEqual(RULED);
  });

  it('sweep: the line for EVERY cliff of EVERY profile in the pinned catalog names none of them', async () => {
    const { cliffLine } = await import('../src/engine.js');
    const { allProfiles } = await import('@warmdrift/kgauto-compiler');
    let rendered = 0;
    let guarded = 0;
    for (const p of allProfiles()) {
      for (const c of p.cliffs) {
        const l = cliffLine(p.id, c, c.threshold);
        rendered++;
        expect(named(`${l.title} ${l.detail} ${l.basis}`), `${p.id} ${c.metric}`).toEqual([]);
        if (named(c.reason).length > 0) {
          guarded++;
          expect(l.detail).toContain("The catalog's note for this rule is written for our own records and is not quoted.");
          expect(l.detail).toMatch(/What the compiler does about it: /);
          expect(l.detail).toMatch(/Evidence: /);
        }
      }
    }
    // 18 bundled cliffs in 2.0.0-alpha.133; 2 of their reasons name one of our applications (claude-haiku-4-5, gemini-2.5-flash).
    expect(rendered).toBe(18);
    expect(guarded).toBe(2);
  });

  it('sweep through the card: every cliff the check can fire, forced over its line, prints none of them', async () => {
    const { runCheck } = await import('../src/engine.js');
    const { allProfiles } = await import('@warmdrift/kgauto-compiler');
    let fired = 0;
    for (const p of allProfiles()) {
      for (const c of p.cliffs) {
        if (c.metric !== 'input_tokens' && c.metric !== 'tool_count') continue;
        const site = {
          id: 'x.ts:1',
          model: p.id,
          platform: 'provider-api',
          expectsStructuredOutput: true,
          ...(c.whenIntent ? { archetype: c.whenIntent } : {}),
          ...(c.metric === 'input_tokens' ? { estInputTokens: c.threshold } : { toolCount: c.threshold }),
        };
        const r = runCheck({ project: { name: 't' }, callSites: [site as never] }, { resolve: (id) => ({ canonical: id, profile: id === p.id ? p : undefined }) });
        fired += r.findings.filter((f) => f.title.includes(' cliff at ')).length;
        expect(named(r.card), p.id).toEqual([]);
      }
    }
    expect(fired).toBe(10);
  });

  it('the haiku-4-5 line keeps its action and its evidence, and quotes nothing', async () => {
    const { runCheck } = await import('../src/engine.js');
    const r = runCheck({ project: { name: 't' }, callSites: [{ id: 'a.ts:1', model: 'claude-haiku-4-5', platform: 'provider-api', archetype: 'summarize', estInputTokens: 12_000, expectsStructuredOutput: true }] });
    const f = r.findings.find((x) => x.title.includes('cliff'))!;
    // Amendment B: no quality sentence without an evidence record (B2); 12,000 on a rule at 12,000 is at the line (B1).
    expect(f.detail).toBe(
      "The catalog's note for this rule is written for our own records and is not quoted. " +
        "What the compiler does about it: it stops trusting this model's structured output at or above this size on summarize work, and ranks the model lower for such a request. " +
        "Evidence: no evidence record; the catalog's note describes a measured incident. " +
        'Your estimate of 12,000 sits at the line.',
    );
  });
});

describe('R3 — a gateway is not the provider’s own API', () => {
  const OR_ID = 'openrouter/anthropic/claude-3-opus-20240229';
  const lifecycleLines = async (site: Record<string, unknown>) => {
    const { runCheck } = await import('../src/engine.js');
    const r = runCheck({ project: { name: 't' }, callSites: [{ id: 'a.ts:1', model: OR_ID, ...site } as never] });
    return r.findings.filter((f) => f.title.includes("own API"));
  };

  it('resolveId marks openrouter/ as the gateway, and a bare provider/ prefix as nothing', async () => {
    const { resolveId } = await import('../src/lifecycle.js');
    expect(resolveId(OR_ID).partner).toBe('openrouter');
    expect(resolveId(OR_ID).base).toBe('claude-3-opus-20240229');
    expect(resolveId('anthropic/claude-3-opus-20240229').partner).toBeUndefined();
  });

  it('the fresh-eyes case: openrouter/… with platform: provider-api is likely, says the gateway may keep its own schedule, and names the disagreement', async () => {
    const ls = await lifecycleLines({ platform: 'provider-api' });
    expect(ls).toHaveLength(1);
    expect(ls[0]!.confidence).toBe('likely');
    expect(ls[0]!.title.startsWith("On Anthropic's own API, `openrouter/anthropic/claude-3-opus-20240229`")).toBe(true);
    expect(ls[0]!.detail).toContain('This id is written for OpenRouter, a gateway, and OpenRouter may keep its own schedule for the model (its page: https://openrouter.ai/docs/guides/overview/models).');
    expect(ls[0]!.detail).toContain("The extract and the code disagree: the extract says the provider's own API, but the id's form is OpenRouter's.");
    expect(ls[0]!.basis).toContain('OpenRouter: https://openrouter.ai/docs/guides/overview/models');
  });

  it('openrouter/… with no platform stated gets the gateway sentence, not the generic clause', async () => {
    const ls = await lifecycleLines({});
    expect(ls[0]!.confidence).toBe('likely');
    expect(ls[0]!.detail).toContain('OpenRouter may keep its own schedule');
    expect(ls[0]!.detail).not.toContain('If this call goes through a cloud platform');
    expect(ls[0]!.detail).not.toContain('disagree');
  });

  it('openrouter/… with platform: other (a gateway) is consistent: no disagreement', async () => {
    const ls = await lifecycleLines({ platform: 'other' });
    expect(ls[0]!.detail).toContain('OpenRouter may keep its own schedule');
    expect(ls[0]!.detail).not.toContain('disagree');
  });

  it('a bare provider/ prefix keeps 0.4.0’s behaviour: certain on a stated provider API', async () => {
    const { runCheck } = await import('../src/engine.js');
    const r = runCheck({ project: { name: 't' }, callSites: [{ id: 'a.ts:1', model: 'anthropic/claude-3-opus-20240229', platform: 'provider-api' }] });
    const ls = r.findings.filter((f) => f.title.includes('own API'));
    expect(ls).toHaveLength(1);
    expect(ls[0]!.confidence).toBe('certain');
  });

  it('--model-facts on the gateway form says the gateway may keep its own schedule', async () => {
    const { renderModelFacts } = await import('../src/model-facts.js');
    const t = renderModelFacts(OR_ID);
    expect(t).toContain(
      "- this id form is OpenRouter's, a gateway: Anthropic's word above is for Anthropic's own API, and OpenRouter may keep its own schedule (https://openrouter.ai/docs/guides/overview/models)",
    );
  });
});

describe('R4 — every npx command the check prints names this version', () => {
  // (Amendment B5: the "version.ts reads package.json" test is dropped — version.ts reads package.json
  // at run time, so it could not fail; one source of the version is the design.)

  it('the usage text and the extract contract pin @<version> on every npx line', async () => {
    const ins = (await import('../src/instructions.js')) as Record<string, unknown>;
    const printed = [String(ins.USAGE), String(ins.START_CHECK_INSTRUCTIONS)];
    const npx = printed.flatMap((t) => t.split('\n').filter((l) => /\bnpx\b/.test(l)));
    // 5 in the usage text, 1 in the contract — a test that finds none would pass vacuously.
    expect(npx.length).toBe(6);
    for (const l of npx) expect(l).toContain(`npx -y @warmdrift/kgauto-check@${pkg.version} `);
    for (const l of npx) expect(l).not.toMatch(/@warmdrift\/kgauto-check(?!@)/);
  });
});

describe('R5 — two sentences', () => {
  it('a model already shut down says so without "not before": the floor is the page\'s earliest date, in the past tense', async () => {
    const { runCheck } = await import('../src/engine.js');
    const r = runCheck({ project: { name: 't' }, callSites: [{ id: 'a.ts:1', model: 'gemini-3-pro-preview', platform: 'provider-api' }] });
    const t = r.findings.find((f) => f.title.includes('gemini-3-pro-preview'))!.title;
    expect(t).toBe("On Google's own API, `gemini-3-pro-preview` has been shut down (the earliest shutdown date the page gave was 2026-03-09); its page names `gemini-3.1-pro-preview`");
    expect(t).not.toMatch(/not before/);
  });

  it('--model-facts on the same id says it the same way', async () => {
    const { renderModelFacts } = await import('../src/model-facts.js');
    const t = renderModelFacts('gemini-3-pro-preview');
    expect(t).toContain("Google's word: **shut down** (the earliest shutdown date the page gave was 2026-03-09)");
    expect(t.split('\n')[2]).not.toMatch(/not before/);
  });

  it('the Likely heading names all three kinds of line under it', async () => {
    const { runCheck } = await import('../src/engine.js');
    const r = runCheck({ project: { name: 't' }, callSites: [{ id: 'a.ts:1', model: 'gemini-2.5-flash', retry: 'none' }] });
    const heading = r.card.split('\n').find((l) => l.startsWith('## Likely'))!;
    expect(heading).toBe(
      '## Likely — priced from your estimates or a catalog value no provider page is cited for; a provider’s word where the call may not use its own API; no retry or fallback found in the code',
    );
    // the card under it carries one of each of the two new kinds
    const likely = r.findings.filter((f) => f.confidence === 'likely').map((f) => f.title);
    expect(likely.some((t) => t.startsWith("On Google's own API"))).toBe(true);
    expect(likely).toContain('no second model and no retry found at this site');
  });
});

describe('R7 — the share path says what it stores', () => {
  const SENTENCE =
    'With --share, one row is stored: a row number, the time it arrived, the project name, the extract, the card, the check’s version and the catalog’s version.';

  it('the usage text, the extract contract and the README each carry the one stored-fields sentence', async () => {
    const ins = (await import('../src/instructions.js')) as Record<string, unknown>;
    expect(String(ins.USAGE)).toContain(SENTENCE);
    expect(String(ins.START_CHECK_INSTRUCTIONS)).toContain(SENTENCE);
    expect(readFileSync(join(PKG_DIR, 'README.md'), 'utf8')).toContain(SENTENCE);
    // the old claim the row does not show ("nothing else") is gone from what the CLI prints
    expect(String(ins.START_CHECK_INSTRUCTIONS)).not.toMatch(/the card, nothing else/);
  });

  it('the confirmation names the destination, the submission and the stored fields', async () => {
    const share = (await import('../src/share.js')) as typeof import('../src/share.js');
    expect(share.SHARE_STORED_SENTENCE).toBe(SENTENCE);
    expect(share.shareConfirmation('https://example.test/api', '42')).toBe(`[--share] Sent to https://example.test/api (submission 42). ${SENTENCE}`);
  });

  it('success is the endpoint’s own {ok: true, id}, and nothing less', async () => {
    const { postShare } = (await import('../src/share.js')) as typeof import('../src/share.js');
    const answer = (status: number, json: unknown) =>
      (async () => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const body = { extract: { project: { name: 'x' }, callSites: [] }, card: 'c', check_version: '0', catalog_version: '0' };
    expect(await postShare('http://e', body, answer(200, { ok: true, id: 7 }))).toEqual({ ok: true, id: '7' });
    expect((await postShare('http://e', body, answer(200, { id: 7 }))).ok).toBe(false);
    expect((await postShare('http://e', body, answer(200, { ok: true }))).ok).toBe(false);
    expect((await postShare('http://e', body, answer(502, { error: 'store failed' }))).ok).toBe(false);
    const throws = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await postShare('http://e', body, throws)).toEqual({ ok: false, reason: 'ECONNREFUSED' });
  });

  it('the body the CLI posts holds the four keys the endpoint reads, and nothing else', async () => {
    const { postShare } = (await import('../src/share.js')) as typeof import('../src/share.js');
    let sent: Record<string, unknown> = {};
    const capture = (async (_u: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, id: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    await postShare('http://e', { extract: { project: { name: 'x' }, callSites: [] }, card: 'c', check_version: '1', catalog_version: '2' }, capture);
    expect(Object.keys(sent).sort()).toEqual(['card', 'catalog_version', 'check_version', 'extract']);
  });
});

describe('R9 — version, changelog, readme', () => {
  it('the package is 0.4.1 and the changelog says so first', () => {
    expect(pkg.version).toBe('0.4.1');
    const log = readFileSync(join(PKG_DIR, 'CHANGELOG.md'), 'utf8');
    expect(log.split('\n').find((l) => l.startsWith('## '))).toBe('## 0.4.1 — 2026-11-14');
  });

  it("the README's example card is this build's output on the stored example extract, byte for byte", async () => {
    const { runCheck } = await import('../src/engine.js');
    const { ExtractSchema } = await import('../src/extract.js');
    const ex = ExtractSchema.parse(JSON.parse(readFileSync(join(PKG_DIR, 'tests/fixtures/readme-example.json'), 'utf8')));
    const readme = readFileSync(join(PKG_DIR, 'README.md'), 'utf8');
    const shown = /````markdown\n([\s\S]*?)\n````/.exec(readme)?.[1];
    expect(shown).toBe(runCheck(ex).card);
    expect(readme).toContain(`This is the output of \`kgauto-check ${pkg.version}\``);
  });
});

describe('R6 — MIT', () => {
  it('package.json says MIT and ships the LICENSE file', () => {
    expect(pkg.license).toBe('MIT');
    expect(pkg.files).toContain('LICENSE');
  });

  it('LICENSE is the MIT text with the ruled holder line', () => {
    const path = join(PKG_DIR, 'LICENSE');
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text.startsWith('MIT License\n')).toBe(true);
    expect(text).toContain('Copyright (c) 2026 Communicating Vessels contributors');
    expect(text).toContain('Permission is hereby granted, free of charge, to any person obtaining a copy');
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });
});
