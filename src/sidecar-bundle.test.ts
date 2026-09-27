import { describe, expect, test } from "bun:test";

import { MEMORY_TOOL_DEFINITIONS } from "./tools.js";
import {
  HUB_CREDENTIAL_HANDLE,
  memory,
  SIDECAR_BUNDLE_ID,
} from "./sidecar-bundle.js";

type Recorded = { url: string; init?: RequestInit };

function env(recorded: Recorded[], respond: () => Response) {
  const credential = {
    kind: "http" as const,
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      recorded.push({
        url: String(input),
        ...(init !== undefined ? { init } : {}),
      });
      return Promise.resolve(respond());
    },
    dispose: () => undefined,
  };
  return {
    address: "run-1@acme.example.com",
    capabilities: {
      resolve: (key: string) => {
        if (key !== "credentials")
          throw new Error(`unexpected capability ${key}`);
        return {
          resolve: (handle: string) => {
            if (handle !== HUB_CREDENTIAL_HANDLE) {
              throw new Error(`unexpected handle ${handle}`);
            }
            return Promise.resolve(credential);
          },
        };
      },
    },
  } as never;
}

const ok = () =>
  new Response(
    JSON.stringify({ data: { documentId: "doc_1", versionId: "ver_1" } }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );

const signal = new AbortController().signal;

describe("the memory sidecar bundle", () => {
  test("declares every memory tool under the package-namespaced id", () => {
    expect(memory.id).toBe(SIDECAR_BUNDLE_ID);
    expect(memory.requires).toEqual(["capabilities", "address"]);
    const bundle = memory(env([], ok));
    expect(bundle.definitions.map((def) => def.name)).toEqual(
      MEMORY_TOOL_DEFINITIONS.map((def) => def.name),
    );
  });

  test("adds through the run-scoped route, carrying the run address", async () => {
    const recorded: Recorded[] = [];
    const bundle = memory(env(recorded, ok));
    const result = await bundle.run(
      {
        id: "call-1",
        name: "memory_add",
        arguments: { title: "Notes", text: "body", kind: "note" },
      },
      signal,
    );

    expect(result.isError).toBeUndefined();
    expect(recorded[0]?.url).toBe("/api/workflow-memory/add");
    const headers = recorded[0]?.init?.headers as Record<string, string>;
    expect(headers["x-workflow-run-address"]).toBe("run-1@acme.example.com");
    expect(JSON.parse(String(recorded[0]?.init?.body))).toEqual({
      title: "Notes",
      text: "body",
      kind: "note",
    });
  });

  test("resolves the credential once across calls", async () => {
    const recorded: Recorded[] = [];
    const bundle = memory(env(recorded, ok));
    await bundle.run({ id: "a", name: "memory_list", arguments: {} }, signal);
    await bundle.run({ id: "b", name: "memory_list", arguments: {} }, signal);
    expect(recorded).toHaveLength(2);
    await bundle.dispose?.();
  });

  test("a hub error comes back as a tool error, never a throw", async () => {
    const bundle = memory(
      env(
        [],
        () =>
          new Response(JSON.stringify({ error: "search failed" }), {
            status: 502,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const result = await bundle.run(
      { id: "c", name: "memory_search", arguments: { query: "q" } },
      signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("search failed");
  });

  test("an unknown tool name is a tool error", async () => {
    const recorded: Recorded[] = [];
    const bundle = memory(env(recorded, ok));
    const result = await bundle.run(
      { id: "d", name: "memory_nope", arguments: {} },
      signal,
    );
    expect(result.isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });
});

describe("every declared tool maps onto a route", () => {
  const calls: Array<[string, Record<string, unknown>, string]> = [
    ["memory_add", { title: "T", text: "b" }, "/api/workflow-memory/add"],
    ["memory_search", { query: "q", limit: 5 }, "/api/workflow-memory/search"],
    ["memory_list", { limit: 5 }, "/api/workflow-memory/list?limit=5"],
    [
      "memory_feed",
      { after: 3, limit: 10, exclude_generator: "resident-distiller" },
      "/api/workflow-memory/feed?after=3&limit=10&exclude_generator=resident-distiller",
    ],
  ];

  for (const [name, args, url] of calls) {
    test(`${name} calls ${url}`, async () => {
      const recorded: Recorded[] = [];
      const bundle = memory(env(recorded, ok));
      const result = await bundle.run(
        { id: name, name, arguments: args },
        signal,
      );
      expect(result.isError).toBeUndefined();
      expect(recorded[0]?.url).toBe(url);
      await bundle.dispose?.();
    });
  }

  test("the search body forwards only schema fields", async () => {
    const recorded: Recorded[] = [];
    const bundle = memory(env(recorded, ok));
    await bundle.run(
      {
        id: "s",
        name: "memory_search",
        arguments: { query: "q", kinds: ["note"], tenantId: "spoofed" },
      },
      signal,
    );
    expect(JSON.parse(String(recorded[0]?.init?.body))).toEqual({
      query: "q",
      kinds: ["note"],
    });
  });

  test("the loader's namespaced name resolves to the declared one", async () => {
    const recorded: Recorded[] = [];
    const bundle = memory(env(recorded, ok));
    await bundle.run(
      {
        id: "n",
        name: "@corbits/memory/sidecar-bundle:memory_list",
        arguments: {},
      },
      signal,
    );
    expect(recorded[0]?.url).toBe("/api/workflow-memory/list");
  });

  test("a body-less hub error still reads as a tool error", async () => {
    const bundle = memory(env([], () => new Response("nope", { status: 500 })));
    const result = await bundle.run(
      { id: "e", name: "memory_list", arguments: {} },
      signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("the hub answered 500");
  });
});
