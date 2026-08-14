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
  // Bound to a const rather than passed as a fresh object literal: some
  // `@intx/agent` versions add a static `definitions` field to defineTool's
  // options (so callers can enumerate tool names without instantiating the
  // factory) that this package's own pinned version predates. Routing
  // through a named variable gets normal structural (duck-typed) parameter
  // assignment instead of TypeScript's excess-property check on literals,
  // so this call type-checks against either shape — the extra field is
  // simply unused by an older defineTool at runtime.
  const toolOpts = {
    id: opts.id,
    requires: MEMORY_TOOL_ENV_KEYS,
    definitions: [{ name: opts.name }],
    factory(env: MemoryInstallEnv) {
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
        run: runner.run.bind(runner),
      };
    },
  };
  return defineTool<MemoryInstallEnv>(toolOpts);
}
