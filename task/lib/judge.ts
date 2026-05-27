import * as untracedAi from "ai";
import type { LanguageModel } from "ai";
import { wrapAISDK, traced } from "braintrust";
import { z } from "zod";
import type { AiSdkMcpTools } from "./mcpEvalClient.ts";
import type { Verdict } from "./types.ts";

const ai = wrapAISDK(untracedAi);

// Max LLM steps before forcing a stop, to avoid runaway tool-calling loops.
const DEFAULT_STEP_COUNT = 10;

// Tools whose names start with these prefixes mutate state and are hidden from
// the judge so it can only read while verifying.
const MUTATING_PREFIXES = ["create", "drop", "delete", "update", "insert"];

export function readonlyTools(tools: AiSdkMcpTools): AiSdkMcpTools {
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => {
      const lower = name.toLowerCase();
      return !MUTATING_PREFIXES.some((prefix) => lower.startsWith(prefix));
    }),
  ) as AiSdkMcpTools;
}

const scoreSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("0.0 = criteria not satisfied at all, 1.0 = fully satisfied"),
  explanation: z.string().describe("brief explanation of the score"),
});

function makeSubmitScoreTool(onSubmit: (verdict: Verdict) => void) {
  return untracedAi.tool({
    description: "Submit your final score. Call this exactly once when ready.",
    inputSchema: scoreSchema,
    execute: async (input) => {
      onSubmit(input);
      return { ok: true };
    },
  });
}

function makeGetConversationTool(conversation: string) {
  return untracedAi.tool({
    description:
      "Returns the assistant's conversation transcript (its messages, tool calls, and tool results). Call this when the criteria references $conversation.",
    inputSchema: z.object({}),
    execute: async () => ({ conversation }),
  });
}

function makeGetResultTool(result: string) {
  return untracedAi.tool({
    description:
      "Returns the assistant's final response: the text of its last message in the conversation. Call this when the criteria references $result.",
    inputSchema: z.object({}),
    execute: async () => ({ result }),
  });
}

const FALLBACK: Verdict = {
  score: 0,
  explanation: "Judge did not submit a score before the step limit.",
};

// Judges database state against free-text criteria using read-only MCP tools.
// The conversation and final result are NOT injected into the prompt; the judge
// must call get_conversation / get_result if the criteria reference
// $conversation / $result.
export async function judgeState(params: {
  model: LanguageModel;
  tools: AiSdkMcpTools;
  criteria: string | string[];
  conversation: string;
  result: string;
  dbName: string;
}): Promise<Verdict> {
  const { model, tools, criteria, conversation, result: agentResult, dbName } =
    params;

  let verdict: Verdict = FALLBACK;
  const submitScore = makeSubmitScoreTool((submitted) => {
    verdict = submitted;
  });

  await traced(
    async () => {
      await ai.generateText({
        model,
        system: buildStateJudgeSystemPrompt(criteria, dbName),
        messages: [
          {
            role: "user" as const,
            content:
              "Verify the criteria, then call submit-score exactly once.",
          },
        ],
        tools: {
          ...readonlyTools(tools),
          get_conversation: makeGetConversationTool(conversation),
          get_result: makeGetResultTool(agentResult),
          "submit-score": submitScore,
        },
        stopWhen: [
          untracedAi.stepCountIs(DEFAULT_STEP_COUNT),
          untracedAi.hasToolCall("submit-score"),
        ],
      });
    },
    { name: "llm-judge" },
  );

  return verdict;
}

// Compares the assistant's reported results in the conversation transcript to a
// ground-truth result set computed from the reference pipeline.
export function judgeDataMatch(params: {
  expectedDocs: unknown[];
  conversation: string;
}): Verdict {
  const { expectedDocs, conversation } = params;
  const candidates = extractReportedDocSets(conversation);

  if (expectedDocs.length === 0) {
    const matchedEmpty = candidates.some((docs) => docs.length === 0);
    return {
      score: matchedEmpty ? 1 : 0,
      explanation: matchedEmpty
        ? "Assistant reported an empty result set as expected."
        : "Expected no results but the assistant reported data.",
    };
  }

  if (candidates.length === 0) {
    return {
      score: 0,
      explanation: "No result data found in the assistant conversation.",
    };
  }

  let bestScore = 0;
  let bestMatched = 0;
  for (const reported of candidates) {
    const matched = countMatchingDocs(expectedDocs, reported);
    const score = matched / expectedDocs.length;
    if (score > bestScore) {
      bestScore = score;
      bestMatched = matched;
    }
  }

  return {
    score: bestScore,
    explanation:
      bestScore === 1
        ? `Reported results match all ${expectedDocs.length} expected document(s).`
        : bestMatched === 0
          ? `None of the ${expectedDocs.length} expected document(s) were found in the assistant's reported results.`
          : `Matched ${bestMatched}/${expectedDocs.length} expected document(s).`,
  };
}

function buildStateJudgeSystemPrompt(
  criteria: string | string[],
  dbName: string,
): string {
  const list = Array.isArray(criteria) ? criteria : [criteria];
  return [
    "You are evaluating a MongoDB AI assistant on behalf of a human tester.",
    "Decide whether the criteria below are satisfied and produce a score from 0 to 1.",
    "",
    "### Criteria",
    ...list.map((c, i) => `${i + 1}. ${c}`),
    "",
    "### Tools",
    `- Use the MCP tools to inspect the current database state. Operate ONLY on the database named '${dbName}'.`,
    "- If a criterion references $conversation, call get_conversation to read the assistant's transcript.",
    "- If a criterion references $result, call get_result to read the assistant's final response.",
    "- Call submit-score exactly once with your score and a brief explanation. Do not stop without calling it.",
    "",
    "### Scoring",
    "- 1.0 = every criterion fully satisfied; partial credit proportional to how many are satisfied; 0.0 = none.",
  ].join("\n");
}

function extractReportedDocSets(conversation: string): unknown[][] {
  const candidates: unknown[][] = [];

  for (const match of conversation.matchAll(
    /<tool_result[^>]*>([\s\S]*?)<\/tool_result>/g,
  )) {
    collectDocSets(parseJson(match[1]), candidates);
  }

  for (const match of conversation.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    collectDocSets(parseJson(match[1].trim()), candidates);
  }

  return candidates;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function collectDocSets(value: unknown, out: unknown[][]): void {
  if (value === undefined) return;

  if (Array.isArray(value)) {
    if (value.length === 0 || isRecord(value[0])) {
      out.push(value);
    }
    for (const item of value) {
      collectDocSets(item, out);
    }
    return;
  }

  if (isRecord(value)) {
    out.push([value]);
    for (const nested of Object.values(value)) {
      collectDocSets(nested, out);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDoc(doc: unknown): string {
  return JSON.stringify(normalizeValue(doc));
}

function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (isRecord(value) && typeof value.toJSON === "function") {
    return normalizeValue(value.toJSON());
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "_id") continue;
      out[key] = normalizeValue(value[key]);
    }
    return out;
  }
  return value;
}

function countMatchingDocs(expected: unknown[], reported: unknown[]): number {
  const reportedKeys = [...reported.map(normalizeDoc)];
  let matched = 0;

  for (const doc of expected) {
    const key = normalizeDoc(doc);
    const index = reportedKeys.indexOf(key);
    if (index === -1) continue;
    matched += 1;
    reportedKeys.splice(index, 1);
  }

  return matched;
}
