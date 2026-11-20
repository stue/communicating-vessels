import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ExtractSchema } from './extract.js';
import { runCheck, switchName } from './engine.js';
import { SERVER_INSTRUCTIONS, START_CHECK_INSTRUCTIONS } from './instructions.js';
import { OBSERVE_DAY_PLAN } from './observe-plan.js';
import { renderModelFacts } from './model-facts.js';
import { CHECK_VERSION } from './version.js';
import { readForRun } from './pages.js';
import { SHARE_ENDPOINT_DEFAULT, SHARE_STORED_SENTENCE, postShare, shareConfirmation, shareFailure } from './share.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/** Test seams: the page read's fetch, the share POST's fetch, and the environment (for the endpoint override and the read switch). */
export interface ServerSeams {
  pageFetch?: typeof fetch;
  shareFetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/**
 * 0.4.3 (R1): the optional input that stops the read on the server, as the CLI's flag does. Its name is the
 * flag's (the next line); every tool that reads takes it as `...NO_READ_INPUT` and asks `noReadAsked(input)`.
 */
const NO_READ_KEY = 'offline' as const; // the server's name for the CLI's --offline
const NO_READ_INPUT = {
  [NO_READ_KEY]: z
    .boolean()
    .optional()
    .describe('true: read no provider page in this run; each provider line then gives the day its page was read'), // Amendment A4
};
const noReadAsked = (input: { [NO_READ_KEY]?: boolean }) => input[NO_READ_KEY] === true;

export function buildServer(seams: ServerSeams = {}): McpServer {
  const env = seams.env ?? process.env;
  const read = (noRead: boolean) => readForRun({ switchedOff: noRead, switchName: switchName('mcp'), fetchImpl: seams.pageFetch, env });
  const server = new McpServer(
    { name: 'kgauto-check', version: CHECK_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'start_check',
    {
      title: 'Start a kgauto check',
      description:
        'Call this FIRST. Returns extraction instructions: what to read from this project and how to build the extract for run_check. The extract carries identifiers and counts only — never prompt text, code, or secrets.',
      inputSchema: {},
    },
    async () => text(START_CHECK_INSTRUCTIONS),
  );

  server.registerTool(
    'run_check',
    {
      title: 'Run the check',
      description:
        "Runs the deterministic kgauto check on your extract against the bundled verified model catalog and the providers' pages, read in this run (the same public pages whatever the extract holds; nothing about the project is sent). Returns a findings card grouped by confidence tier (certain / likely / measurable-only) — present it to your human verbatim.",
      inputSchema: { extract: ExtractSchema, ...NO_READ_INPUT },
    },
    async (input) => {
      const { extract } = input;
      const pages = await read(noReadAsked(input));
      const result = runCheck(extract, { pages, surface: 'mcp' });
      return text(result.card);
    },
  );

  server.registerTool(
    'get_model_facts',
    {
      title: 'Model facts',
      description:
        "What the provider's own deprecation page says about one model id (retired, shut down, deprecated, legacy), with when that page was read, then what kgauto's verified catalog knows: doc-verified prices and limits, capability flags, known quality cliffs. Honest miss when the model is unknown — no fabricated verdicts.",
      inputSchema: { model: z.string().min(1), ...NO_READ_INPUT },
    },
    async (input) => text(renderModelFacts(input.model, { pages: await read(noReadAsked(input)), surface: 'mcp' })),
  );

  server.registerTool(
    'get_observe_day_plan',
    {
      // Amendment A5: the plain words first (until fix pass 1: "The one-day observe run")
      title: 'One day of recorded calls (the observe day)',
      description:
        "Rung 2: what one day of recorded calls on this project's real traffic, with no change to where any call goes, would measure, and the two honesty requirements any setup must carry (named row destination; observation never intervenes). Ends in a human decision by design.",
      inputSchema: {},
    },
    async () => text(OBSERVE_DAY_PLAN),
  );

  // 0.4.3 (R5): what --share does on the CLI, for an MCP run — offered after the card, run only on the person's yes.
  server.registerTool(
    'share_card',
    {
      title: 'Share the card (only on your human’s yes)',
      description:
        "Sends this check's card and the extract to kgauto, so the catalog learns what real projects look like. Offer it AFTER presenting the card from run_check; call it only if your human says yes, never by default, and set humanSaidYes to true only then. " +
        SHARE_STORED_SENTENCE +
        ' Returns the card that was stored, then where it went and the submission number, or that the send failed.',
      inputSchema: {
        extract: ExtractSchema,
        humanSaidYes: z.literal(true).describe('true only when your human said yes to sharing this card'),
        ...NO_READ_INPUT,
      },
    },
    async (input) => {
      const { extract } = input;
      const endpoint = env.KGAUTO_SHARE_ENDPOINT_OVERRIDE || SHARE_ENDPOINT_DEFAULT;
      const pages = await read(noReadAsked(input));
      const result = runCheck(extract, { pages, share: true, surface: 'mcp' });
      // Never throws: postShare answers {ok: false, reason} on any failure.
      const out = await postShare(
        endpoint,
        { extract, card: result.card, check_version: CHECK_VERSION, catalog_version: result.catalogVersion },
        seams.shareFetch,
      );
      return text(`${result.card}\n\n${out.ok ? shareConfirmation(endpoint, out.id, 'share_card') : shareFailure(out.reason, 'share_card')}`);
    },
  );

  return server;
}

export async function startStdio(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
