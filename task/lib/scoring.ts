import type { LanguageModel } from "ai";
import type { Document } from "mongodb";
import { judgeDataMatch, judgeState } from "./judge.ts";
import { getMcpClient, getMongoClient } from "./infra.ts";
import { seedCollectionNames } from "./seeding.ts";
import type {
  CaseScores,
  DbSeedEntry,
  RunEvalExpected,
  RunEvalScorerArgs,
} from "./types.ts";

// Shape Braintrust accepts for a single score (returning null skips it).
type ScoreResult = {
  name: string;
  score: number;
  metadata?: Record<string, unknown>;
};

// Runs every judge for a case while its temp DB is still alive, returning the
// scores keyed by name. Called from the task (not a scorer) so the DB can be
// dropped immediately afterwards; the scorers below just read these back out.
export async function computeCaseScores(params: {
  judgeModel: LanguageModel;
  expected: RunEvalExpected | undefined;
  dbName: string;
  conversation: string;
  result: string;
  seedCollections: string[];
  dbSeed: DbSeedEntry[] | undefined;
}): Promise<CaseScores> {
  const { judgeModel, expected, dbName, conversation, result } = params;
  const scores: CaseScores = {};

  const criteria = expected?.llm_judge;
  if (criteria) {
    const client = await getMcpClient();
    const tools = await client.tools();
    const verdict = await judgeState({
      model: judgeModel,
      tools,
      criteria,
      conversation,
      result,
      dbName,
    });
    scores.llm_judge = {
      score: verdict.score,
      metadata: { explanation: verdict.explanation },
    };
  }

  const match = expected?.data_match;
  if (match) {
    const collection =
      params.seedCollections?.[0] ?? seedCollectionNames(params.dbSeed)[0];

    if (!collection) {
      scores.data_match = {
        score: 0,
        metadata: {
          explanation:
            "No seeded collection to run the reference pipeline against.",
        },
      };
    } else {
      const mongo = await getMongoClient();
      const expectedDocs = await mongo
        .db(dbName)
        .collection(collection)
        .aggregate(match.aggregate as Document[])
        .toArray();

      const verdict = judgeDataMatch({ expectedDocs, conversation });
      scores.data_match = {
        score: verdict.score,
        metadata: {
          explanation: verdict.explanation,
          expectedCount: expectedDocs.length,
        },
      };
    }
  }

  return scores;
}

// LLM judge over free-text criteria (expected.llm_judge). Extracts the score
// computed in the task; skipped (null) when no criteria existed.
export function llmJudgeScore(args: RunEvalScorerArgs): ScoreResult | null {
  const entry = args.output.scores?.llm_judge;
  if (!entry) return null;
  return { name: "llm_judge", score: entry.score, metadata: entry.metadata };
}

// Reference-pipeline data match (expected.data_match). Extracts the score
// computed in the task; skipped (null) when no data_match existed.
export function dataMatchScore(args: RunEvalScorerArgs): ScoreResult | null {
  const entry = args.output.scores?.data_match;
  if (!entry) return null;
  return { name: "data_match", score: entry.score, metadata: entry.metadata };
}
