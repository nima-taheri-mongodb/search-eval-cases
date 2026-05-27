import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { tool as createTool, type Tool } from "ai";
import { StdioRunner, UserConfigSchema } from "./vendor/mongodb-mcp-server/bundle.cjs";

export type AiSdkMcpClient = Awaited<
  ReturnType<typeof experimental_createMCPClient>
>;
export type AiSdkMcpTools = Awaited<ReturnType<AiSdkMcpClient["tools"]>>;

export class McpEvalClient {
  private constructor(
    private readonly aiSdkMcpClient: AiSdkMcpClient,
    private readonly shutdown: () => Promise<void>,
  ) {}

  async close(): Promise<void> {
    await this.aiSdkMcpClient?.close();
    await this.shutdown();
  }

  async tools(): Promise<AiSdkMcpTools> {
    const mcpTools = (await this.aiSdkMcpClient?.tools()) ?? {};
    const wrappedTools: AiSdkMcpTools = {};

    for (const [toolName, tool] of Object.entries(mcpTools)) {
      wrappedTools[toolName] = createTool({
        ...(tool as Tool<unknown, unknown>),
        execute: async (args, options) => {
          try {
            return await tool.execute(args, options);
          } catch (error) {
            return {
              isError: true,
              content: JSON.stringify(error),
            };
          }
        },
      }) as AiSdkMcpTools[string];
    }

    return wrappedTools;
  }

  static async create(mdbConnectionString: string): Promise<McpEvalClient> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const runner = new InMemoryMcpRunner({
      userConfig: UserConfigSchema.parse({
        connectionString: mdbConnectionString,
        telemetry: "disabled",
        loggers: ["mcp"],
      }),
    });

    await runner.connect(serverTransport);

    const client = await experimental_createMCPClient({
      transport: clientTransport,
    });

    return new McpEvalClient(client, async () => {
      await clientTransport.close();
      await runner.disconnect();
    });
  }
}

class InMemoryMcpRunner extends StdioRunner {
  constructor(options: ConstructorParameters<typeof StdioRunner>[0]) {
    super(options);
  }

  private connectedServer?: {
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
  };

  async connect(serverTransport: Transport): Promise<void> {
    const server = await this.createServer();
    this.connectedServer = server;
    await server.connect(serverTransport);
  }

  async disconnect(): Promise<void> {
    await this.connectedServer?.close();
    this.connectedServer = undefined;
  }
}

export function createLazyMcpEvalClient(connectionString: string): [
  getClient: () => Promise<McpEvalClient>,
  closeClient: () => Promise<void>,
] {
  let client: McpEvalClient | null = null;
  let pending: Promise<McpEvalClient> | null = null;

  async function getClient(): Promise<McpEvalClient> {
    if (client) {
      return client;
    }

    if (!pending) {
      pending = McpEvalClient.create(connectionString).then((result) => {
        client = result;
        return result;
      });
    }

    return pending;
  }

  async function closeClient(): Promise<void> {
    if (!client) {
      return;
    }

    await client.close();
    client = null;
    pending = null;
  }

  return [getClient, closeClient];
}
