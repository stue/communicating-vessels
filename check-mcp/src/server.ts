import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ExtractSchema } from './extract.js';
import { runCheck } from './engine.js';
import { SERVER_INSTRUCTIONS, START_CHECK_INSTRUCTIONS } from './instructions.js';
import { OBSERVE_DAY_PLAN } from './observe-plan.js';
import { renderModelFacts } from './model-facts.js';
import { CHECK_VERSION } from './version.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function buildServer(): McpServer {
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
        'Runs the deterministic kgauto check on your extract, fully offline against the bundled verified model catalog. Returns a findings card grouped by confidence tier (certain / likely / measurable-only) — present it to your human verbatim.',
      inputSchema: { extract: ExtractSchema },
    },
    async ({ extract }) => {
      const result = runCheck(extract);
      return text(result.card);
    },
  );

  server.registerTool(
    'get_model_facts',
    {
      title: 'Model facts',
      description:
        "What the provider's own deprecation page says about one model id (retired, shut down, deprecated, legacy), then what kgauto's verified catalog knows: doc-verified prices and limits, capability flags, known quality cliffs. Honest miss when the model is unknown — no fabricated verdicts.",
      inputSchema: { model: z.string().min(1) },
    },
    async ({ model }) => text(renderModelFacts(model)),
  );

  server.registerTool(
    'get_observe_day_plan',
    {
      title: 'The one-day observe run',
      description:
        "Rung 2: what a one-day, observe-only run on this project's real traffic would measure, and the two honesty requirements any setup must carry (named row destination; observation never intervenes). Ends in a human decision by design.",
      inputSchema: {},
    },
    async () => text(OBSERVE_DAY_PLAN),
  );

  return server;
}

export async function startStdio(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
