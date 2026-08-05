import { describe, expect, mock, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";

import { memoryAdd } from "./add.ts";
import { memorySearch } from "./search.ts";
import { memoryList } from "./list.ts";
import {
  createMemoryHttpClient,
  MEMORY_TOOL_ENV_KEYS,
  readMemoryToolEnv,
  type MemoryToolEnv,
} from "./client.ts";

const BASE = "https://hub.example";
const TENANT = "tenant-abc";
const TOKEN = "tok-xyz";

/** Factories only read memory* keys; cast a minimal env for tests. */
function toolEnv(overrides?: Partial<MemoryToolEnv>): BaseEnv & MemoryToolEnv {
  return {
    memoryBaseUrl: overrides?.memoryBaseUrl ?? BASE,
    memoryTenantId: overrides?.memoryTenantId ?? TENANT,
    memoryAuthToken: overrides?.memoryAuthToken ?? TOKEN,
  } as BaseEnv & MemoryToolEnv;
}

type Captured = {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
};

function installFetch(
  respond: (req: Captured) => { status: number; json: unknown },
) {
  const calls: Captured[] = [];
  const fetchMock = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body =
        typeof init?.body === "string"
          ? init.body
          : init?.body == null
            ? null
            : String(init.body);
      const captured: Captured = { url, method, headers, body };
      calls.push(captured);
      const { status, json } = respond(captured);
      return new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  const previous = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = previous;
    },
  };
}

describe("MEMORY_TOOL_ENV_KEYS", () => {
  test("lists the three credential keys", () => {
    expect([...MEMORY_TOOL_ENV_KEYS]).toEqual([
      "memoryBaseUrl",
      "memoryTenantId",
      "memoryAuthToken",
    ]);
  });
});

describe("readMemoryToolEnv", () => {
  test("rejects empty base url", () => {
    expect(() =>
      readMemoryToolEnv({
        memoryBaseUrl: "",
        memoryTenantId: TENANT,
        memoryAuthToken: TOKEN,
      }),
    ).toThrow(/memoryBaseUrl/);
  });
});

describe("createMemoryHttpClient", () => {
  test("POSTs add under tenant path with Bearer auth", async () => {
    const { calls, restore } = installFetch(() => ({
      status: 200,
      json: { documentId: "doc-1" },
    }));
    try {
      const client = createMemoryHttpClient({
        baseUrl: `${BASE}/`,
        tenantId: TENANT,
        authToken: TOKEN,
      });
      const out = await client.add({ title: "t", text: "body" });
      expect(out).toEqual({ documentId: "doc-1" });
      expect(calls).toHaveLength(1);
      const c = calls[0]!;
      expect(c.method).toBe("POST");
      expect(c.url).toBe(`${BASE}/api/tenants/${TENANT}/memory/add`);
      expect(c.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(c.headers.get("Content-Type")).toBe("application/json");
      const parsed = JSON.parse(c.body ?? "{}") as Record<string, unknown>;
      expect(parsed).toEqual({ title: "t", text: "body" });
      expect(parsed).not.toHaveProperty("tenantId");
      expect(parsed).not.toHaveProperty("principalId");
    } finally {
      restore();
    }
  });

  test("GET list with limit query", async () => {
    const { calls, restore } = installFetch(() => ({
      status: 200,
      json: { events: [] },
    }));
    try {
      const client = createMemoryHttpClient({
        baseUrl: BASE,
        tenantId: TENANT,
        authToken: TOKEN,
      });
      await client.list(5);
      expect(calls[0]!.method).toBe("GET");
      expect(calls[0]!.url).toBe(
        `${BASE}/api/tenants/${TENANT}/memory/list?limit=5`,
      );
      expect(calls[0]!.body).toBeNull();
    } finally {
      restore();
    }
  });

  test("surfaces non-2xx as Error", async () => {
    const { restore } = installFetch(() => ({
      status: 403,
      json: { error: "forbidden" },
    }));
    try {
      const client = createMemoryHttpClient({
        baseUrl: BASE,
        tenantId: TENANT,
        authToken: TOKEN,
      });
      await expect(client.search({ query: "x" })).rejects.toThrow(
        /memory HTTP 403/,
      );
    } finally {
      restore();
    }
  });
});

describe("memoryAdd factory", () => {
  test("declares id and requires", () => {
    expect(memoryAdd.id).toBe("@corbits/memory/add");
    expect([...memoryAdd.requires]).toEqual([...MEMORY_TOOL_ENV_KEYS]);
  });

  test("happy path: body has no identity fields", async () => {
    const { calls, restore } = installFetch(() => ({
      status: 200,
      json: { documentId: "doc-9" },
    }));
    try {
      const bundle = memoryAdd(toolEnv());
      expect(bundle.definitions.map((d) => d.name)).toEqual(["memory_add"]);
      const result = await bundle.run(
        {
          id: "call-1",
          name: "memory_add",
          arguments: { title: "note", text: "hello" },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(result.content).toBe(JSON.stringify({ documentId: "doc-9" }));
      const body = JSON.parse(calls[0]!.body ?? "{}") as Record<string, unknown>;
      expect(body).not.toHaveProperty("tenantId");
      expect(body).not.toHaveProperty("principalId");
      expect(body).not.toHaveProperty("tenant_id");
      expect(body).not.toHaveProperty("principal_id");
    } finally {
      restore();
    }
  });
});

describe("memorySearch factory", () => {
  test("POSTs search with query only", async () => {
    const { calls, restore } = installFetch(() => ({
      status: 200,
      json: { items: [], evidence: "none" },
    }));
    try {
      const bundle = memorySearch(toolEnv());
      const result = await bundle.run(
        {
          id: "call-2",
          name: "memory_search",
          arguments: { query: "standup notes" },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(calls[0]!.url).toBe(
        `${BASE}/api/tenants/${TENANT}/memory/search`,
      );
      expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({
        query: "standup notes",
      });
    } finally {
      restore();
    }
  });
});

describe("memoryList factory", () => {
  test("GETs list without identity in query", async () => {
    const { calls, restore } = installFetch(() => ({
      status: 200,
      json: {
        events: [
          {
            at: "2026-01-01",
            title: "a",
            source: "local",
            tenantId: TENANT,
            principalId: "p",
          },
        ],
      },
    }));
    try {
      const bundle = memoryList(toolEnv());
      const result = await bundle.run(
        {
          id: "call-3",
          name: "memory_list",
          arguments: { limit: 10 },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(calls[0]!.url).toContain("/memory/list?limit=10");
      expect(calls[0]!.url).not.toContain("principal");
    } finally {
      restore();
    }
  });

  test("HTTP error becomes isError tool result", async () => {
    const { restore } = installFetch(() => ({
      status: 401,
      json: { error: "unauthorized" },
    }));
    try {
      const bundle = memoryList(toolEnv());
      const result = await bundle.run(
        { id: "call-4", name: "memory_list", arguments: {} },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
    } finally {
      restore();
    }
  });
});
