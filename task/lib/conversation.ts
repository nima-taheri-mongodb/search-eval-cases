import type { ModelMessage } from "ai";

// Truncate verbose tool outputs so the serialized transcript doesn't overwhelm
// a judge's context window.
const MAX_TOOL_OUTPUT_CHARS = 4000;

function truncate(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

// Produces numbered <turn> blocks (with tool calls/results) consumed by judges
// via the get_conversation tool.
export function serializeMessages(messages: ModelMessage[]): string {
  const blocks: string[] = [];
  let turn = 0;

  for (const msg of messages) {
    const role = String((msg as { role?: string }).role ?? "unknown");
    const content = (msg as Record<string, unknown>).content;
    const inner: string[] = [];

    if (typeof content === "string") {
      if (content) inner.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content as Record<string, unknown>[]) {
        switch (part.type) {
          case "text":
            if (part.text) inner.push(String(part.text));
            break;
          case "tool-call": {
            const id = String(part.toolCallId ?? "");
            const name = String(part.toolName ?? "");
            inner.push(
              `<tool_call id="${id}" name="${name}">${JSON.stringify(part.input)}</tool_call>`,
            );
            break;
          }
          case "tool-result": {
            const id = String(part.toolCallId ?? "");
            const name = String(part.toolName ?? "");
            const output = truncate(
              JSON.stringify(part.output),
              MAX_TOOL_OUTPUT_CHARS,
            );
            inner.push(
              `<tool_result for="${id}" name="${name}">${output}</tool_result>`,
            );
            break;
          }
          default:
            inner.push(JSON.stringify(part));
        }
      }
    }

    if (inner.length === 0) continue;
    turn += 1;
    blocks.push(`<turn n="${turn}" role="${role}">\n${inner.join("\n")}\n</turn>`);
  }

  return blocks.join("\n");
}
