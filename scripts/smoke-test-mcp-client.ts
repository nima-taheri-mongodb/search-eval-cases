import { McpEvalClient } from "../task/lib/mcpEvalClient.ts";

async function main(): Promise<void> {
  const connectionString =
    process.env.MDB_MCP_CONNECTION_STRING ??
    "mongodb://127.0.0.1:27017/?directConnection=true";

  const client = await McpEvalClient.create(connectionString);
  try {
    const tools = await client.tools();
    console.log("toolCount:", Object.keys(tools).length);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
