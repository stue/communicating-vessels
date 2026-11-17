/**
 * The extract contract — what a consumer's coding agent collects from the
 * project it is checking. IDENTIFIERS AND COUNTS ONLY, by design: no prompt
 * text, no source code, no secrets ever enter the extract. The agent reads
 * the repo (it already has access); kgauto reads nothing.
 */
import { z } from 'zod';

/**
 * 0.4.3 (R4): where an id is written —
 *   runs    — code or configuration the project executes or loads in normal use (a default, a constant, a config file the app reads);
 *   test    — tests and their fixtures;
 *   docs    — documentation, a README, a docstring or a comment, an issue template;
 *   example — an example, sample or template a person copies and edits.
 */
export const SiteContextSchema = z.enum(['runs', 'test', 'docs', 'example']);
export type SiteContext = z.infer<typeof SiteContextSchema>;

export const CallSiteSchema = z.object({
  /** Agent-chosen stable label, e.g. "api/summarize.ts:42" or "hunt loop". */
  id: z.string().min(1),
  /** Model id exactly as configured in the project. */
  model: z.string().min(1),
  /** How the model id is selected at this site. */
  modelSelection: z.enum(['hardcoded', 'config', 'env', 'dynamic']).optional(),
  /**
   * 0.4.0 (Amendment B): where the request is served, when the code shows it — the
   * provider's own API, or a cloud platform that serves the provider's models on its
   * own lifecycle schedule. Omit when you cannot tell.
   */
  platform: z.enum(['provider-api', 'vertex', 'bedrock', 'azure', 'other']).optional(),
  /**
   * Best-guess intent archetype from kgauto's dialect (ask, classify,
   * critique, extract, generate, hunt, plan, summarize, transform).
   * Free-form here; validated softly against the roster's dialect.
   */
  archetype: z.string().optional(),
  /** Typical input size in tokens (estimate is fine; ~4 chars/token). */
  estInputTokens: z.number().nonnegative().optional(),
  /** Worst-case input size in tokens, if larger than typical. */
  maxInputTokens: z.number().nonnegative().optional(),
  /** Typical output size in tokens. */
  estOutputTokens: z.number().nonnegative().optional(),
  /** Number of tool definitions sent with the call. */
  toolCount: z.number().int().nonnegative().optional(),
  /** Does the site rely on the model making parallel tool calls? */
  usesParallelToolCalls: z.boolean().optional(),
  /** Does the site parse the response as JSON / expect schema output? */
  expectsStructuredOutput: z.boolean().optional(),
  streaming: z.boolean().optional(),
  /** What happens when the call fails. */
  retry: z.enum(['none', 'same-model', 'fallback-chain', 'unknown']).optional(),
  /** Fallback model ids, when retry is 'fallback-chain'. */
  fallbackModels: z.array(z.string()).optional(),
  /** Rough call volume, if inferable (cron cadence, traffic, logs). */
  estCallsPerMonth: z.number().positive().optional(),
  /** Anything structural the agent thinks matters. Never prompt text. */
  notes: z.string().max(500).optional(),
  /** 0.4.3 (R4): where this call site is written — runs, test, docs or example. */
  context: SiteContextSchema.optional(),
});

/**
 * 0.4.0 (R5) — a model id the project holds where no literal call site
 * carries it: a model picker, a config default, an environment default, a
 * list of supported models. The card reports on its lifecycle; there is no
 * request shape to check it against.
 */
export const ModelMentionSchema = z.object({
  /** Model id exactly as written in the project. */
  model: z.string().min(1),
  /** Where it is written, e.g. "src/config/models.ts:14". */
  where: z.string().min(1),
  modelSelection: z.enum(['hardcoded', 'config', 'env', 'dynamic']).optional(),
  /**
   * 0.4.0 (Amendment B): where the request is served, when the code shows it — the
   * provider's own API, or a cloud platform that serves the provider's models on its
   * own lifecycle schedule. Omit when you cannot tell.
   */
  platform: z.enum(['provider-api', 'vertex', 'bedrock', 'azure', 'other']).optional(),
  notes: z.string().max(500).optional(),
  /** 0.4.3 (R4): where this id is written — runs, test, docs or example. An id in a docstring is listed with `docs`, never left out. */
  context: SiteContextSchema.optional(),
});

export const ExtractSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    description: z.string().max(500).optional(),
  }),
  /** May be empty (0.4.0): a project with no literal call site still gets a card. */
  callSites: z.array(CallSiteSchema),
  /** Model ids no call site carries (0.4.0). */
  models: z.array(ModelMentionSchema).optional(),
  notes: z.string().max(1000).optional(),
});

export type CallSite = z.infer<typeof CallSiteSchema>;
export type ModelMention = z.infer<typeof ModelMentionSchema>;
export type Extract = z.infer<typeof ExtractSchema>;
