import {
  createToolRunner,
  defineTool,
  stringTool,
  type BaseEnv,
} from "@intx/agent";

import {
  createMemoryHttpClient,
  MEMORY_TOOL_ENV_KEYS,
  readMemoryToolEnv,
  type MemoryHttpClient,
  type MemoryToolEnv,
} from "./client.ts";

export type MemoryInstallEnv = BaseEnv & MemoryToolEnv;

type JSONSchemaObject = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

/**
 * Shared defineTool shell for memory HTTP tools.
 * Credentials from env; model args never carry identity.
 */
export function defineMemoryHttpTool(opts: {
  id: string;
  name: string;
  description: string;
  inputSchema: JSONSchemaObject;
  handle: (
    client: MemoryHttpClient,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) => Promise<string>;
}) {
  return defineTool<MemoryInstallEnv>({
    id: opts.id,
    requires: MEMORY_TOOL_ENV_KEYS,
    factory(env) {
      const client = createMemoryHttpClient(readMemoryToolEnv(env));
      const runner = createToolRunner([
        stringTool({
          definition: {
            name: opts.name,
            description: opts.description,
            inputSchema: opts.inputSchema,
          },
          handler: async (args, signal) =>
            opts.handle(client, args, signal),
        }),
      ]);
      return {
        definitions: runner.definitions,
        run: (call, signal) => runner.run(call, signal),
      };
    },
  });
}
