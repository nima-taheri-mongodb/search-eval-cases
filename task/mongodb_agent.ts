import {
  Eval,
  Reporter,
  reportFailures,
  wrapAISDK,
  type EvalParameters,
} from "braintrust";
import { createOpenAI } from "@ai-sdk/openai";
import * as ai from "ai";
import { stepCountIs } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  captureConnectionString,
  dropCaseDb,
  getMcpClient,
  getMongoClient,
  registerTempDb,
  teardown,
} from "./lib/infra.ts";
import { seedCollectionNames, seedTempDb } from "./lib/seeding.ts";
import { serializeMessages } from "./lib/conversation.ts";
import {
  computeCaseScores,
  dataMatchScore,
  llmJudgeScore,
} from "./lib/scoring.ts";
import type {
  RunEvalExpected,
  RunEvalInput,
  RunEvalOutput,
} from "./lib/types.ts";

const PROJECT_NAME = "mongodb-mcp-server-evals";

// Max LLM steps the agent under test may take before being forced to stop.
const AGENT_STEP_LIMIT = 20;

const DEFAULT_SYSTEM_CONTEXT =
  'You are a MongoDB assistant operating autonomously in a single turn; the user cannot answer follow-up questions. Use the available MongoDB MCP tools to fulfill the request end-to-end. Never ask for clarification; make a reasonable decision and finish the task. If the request refers to "the collection" without naming it, discover collections with the list tools and act on the appropriate one (if there is exactly one user collection, use it). Prefer tools over guessing, and briefly confirm what you did when done.';

if (!process.env.BRAINTRUST_API_KEY) {
  throw new Error(
    `The BRAINTRUST_API_KEY environment variable must be set for local execution.
    In the Braintrust sandbox, it is set automatically.
    To run locally, please manually set BRAINTRUST_API_KEY to your Braintrust API key.
    Example:
    export BRAINTRUST_API_KEY=sk-...`,
  );
}

if (!process.env.OPENAI_BASE_URL) {
  throw new Error(
    `The OPENAI_BASE_URL environment variable must be set for local execution.
    In the Braintrust sandbox, it is set automatically.
    To run locally, please manually set OPENAI_BASE_URL to https://gateway.braintrust.dev/v1.
    Example:
    export OPENAI_BASE_URL=https://gateway.braintrust.dev/v1`,
  );
}

const btGateway = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.BRAINTRUST_API_KEY,
});

const { generateText } = wrapAISDK(ai);

const parameters = {
  connectionString: z.string().describe("MongoDB connection string."),
  model: {
    type: "model",
    default: "gpt-4o",
    description: "Model used by the agent under test.",
  },
  systemContext: z
    .string()
    .default(DEFAULT_SYSTEM_CONTEXT)
    .describe("System prompt prepended for the agent under test."),
} satisfies EvalParameters;

// Unique, collision-resistant transient database name for one eval case.
function transientDbName(): string {
  return `eval_${randomUUID().replace(/-/g, "")}`;
}

// Teardown runs here (awaited after the evaluator finishes) rather than via the
// promise returned by Eval(), which resolves lazily under the `bt eval` runner.
const reporter = Reporter<boolean>("mongodb-eval-cleanup", {
  async reportEval(evaluator, result, opts) {
    const { results, summary } = result;
    const failing = results.filter((r) => r.error !== undefined);
    reportFailures(evaluator, failing, opts);

    const scores = Object.entries(summary.scores ?? {})
      .map(([name, s]) => `${name}=${(s.score * 100).toFixed(2)}%`)
      .join(" ");
    console.log(`[eval] ${summary.experimentName ?? PROJECT_NAME} ${scores}`);

    await teardown();
    return failing.length === 0;
  },
  reportRun(reports) {
    return reports.every((ok) => ok);
  },
});

Eval<
  RunEvalInput,
  RunEvalOutput,
  RunEvalExpected,
  void,
  boolean,
  typeof parameters
>(
  PROJECT_NAME,
  {
    data: [
      {
        input: {
          prompt:
            "Create a text search index on the collection for all its fields (future fields included)",
          db_seed: ["movies"],
        },
        expected: {
          llm_judge:
            "A search index on the collection should exist with its 'mapping' being dynamic",
        },
      },
      {
        input: {
          prompt: "Find movies with 'Romance' in their genres",
          db_seed: ["movies"],
        },
        expected: {
          llm_judge:
            "In the $conversation, the assistant should have reported 'Cost anything' (2002) from the 'movies' collection.",
        },
      },
    ],
    task: async (input, hooks) => {
      const connectionString = hooks.parameters.connectionString.trim();
      captureConnectionString(connectionString);

      const dbName = transientDbName();
      registerTempDb(dbName);

      // The task owns the temp DB's full lifecycle: seed it, run the agent, judge
      // the result, then drop it. Scoring happens here (while the DB is alive) so
      // the DB—and its scarce search indexes—can be released immediately in the
      // finally, bounding live indexes to ~maxConcurrency. The scorers downstream
      // just extract the numbers from output.scores.
      try {
        // Seed the transient DB (collections + indexes) and wait for any search
        // indexes to become queryable before the agent runs.
        const mongo = await getMongoClient();
        
        await hooks.span.traced(
          async () => {
            await seedTempDb(mongo, dbName, input.db_seed);
          },
          { name: "seedTempDb" },
        );

        const client = await hooks.span.traced(
          async () => {
            return await getMcpClient();
          },
          { name: "getMcpClient" },
        );
                
        const tools = await client.tools();

        const system = `${hooks.parameters.systemContext}\n\nAll operations must target the MongoDB database named "${dbName}". Always pass this database name to any tool that accepts a database argument, and never use any other database.`;

        const userMessage = { role: "user" as const, content: input.prompt };

        const response = await generateText({
          model: btGateway.chat(hooks.parameters.model),
          system,
          messages: [userMessage],
          tools,
          stopWhen: stepCountIs(AGENT_STEP_LIMIT),
        });

        const conversation = serializeMessages([
          userMessage,
          ...(response.response.messages as ai.ModelMessage[]),
        ]);

        const seedCollections = seedCollectionNames(input.db_seed);

        const scores = await computeCaseScores({
          judgeModel: btGateway.chat(hooks.parameters.model),
          expected: hooks.expected,
          dbName,
          conversation,
          result: response.text,
          seedCollections,
          dbSeed: input.db_seed,
        });

        return {
          text: response.text,
          scores,
        };
      } finally {
        await hooks.span.traced(
          async () => {
            await dropCaseDb(dbName);
          },
          { name: "dropTempDb" },
        );
      }
    },
    scores: [llmJudgeScore, dataMatchScore],
    parameters,
    maxConcurrency: 3,
  },
  reporter,
);
