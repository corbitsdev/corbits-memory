import { describe, expect, it } from "bun:test";

import {
  createMem0MemoryProvider,
  parseSearchResults,
} from "./create-mem0-memory-provider.ts";

type Captured = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function mockFetch(
  handler: (req: Captured) => { status?: number; json?: unknown },
): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }
    let body: unknown;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    const cap: Captured = {
      url,
      method: init?.method ?? "GET",
      headers,
      body,
    };
    calls.push(cap);
    const result = handler(cap);
    const status = result.status ?? 200;
    const payload =
      result.json === undefined ? "" : JSON.stringify(result.json);
    return new Response(payload, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("createMem0MemoryProvider", () => {
  it("rejects missing apiKey", () => {
    expect(() => createMem0MemoryProvider({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("remember sends mapped user_id and never bare principal", async () => {
    const { fetch, calls } = mockFetch(() => ({
      status: 200,
      json: { event_id: "e1", status: "PENDING" },
    }));
    const provider = createMem0MemoryProvider({
      apiKey: "test-key",
      fetch,
    });

    await provider.remember({
      tenantId: "t1",
      principalId: "p1",
      text: "Prefers dark mode",
      metadata: { source: "settings" },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.mem0.ai/v3/memories/add/");
    expect(call.headers["authorization"] ?? call.headers["Authorization"]).toBe(
      "Token test-key",
    );
    const body = call.body as Record<string, unknown>;
    expect(body.user_id).toBe("t1::p1");
    expect(body.user_id).not.toBe("p1");
    expect(body.messages).toEqual([
      { role: "user", content: "Prefers dark mode" },
    ]);
    expect(body.metadata).toEqual({ source: "settings" });
    expect(body.infer).toBe(false);
  });

  it("recall scopes search filters by mapped user_id", async () => {
    const { fetch, calls } = mockFetch(() => ({
      status: 200,
      json: {
        results: [
          { id: "m1", memory: "Lives in SF", score: 0.91 },
          { id: "m2", memory: "Works remote", score: 0.7 },
        ],
      },
    }));
    const provider = createMem0MemoryProvider({
      apiKey: "k",
      baseUrl: "https://mem0.example.com/",
      fetch,
    });

    const hits = await provider.recall({
      tenantId: "acme",
      principalId: "bob",
      query: "where do I live?",
      limit: 3,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://mem0.example.com/v3/memories/search/");
    const body = call.body as Record<string, unknown>;
    expect(body.query).toBe("where do I live?");
    expect(body.top_k).toBe(3);
    expect(body.filters).toEqual({ user_id: "acme::bob" });
    expect(hits).toEqual([
      { text: "Lives in SF", score: 0.91 },
      { text: "Works remote", score: 0.7 },
    ]);
  });

  it("remember/recall reject empty identity (no silent default)", async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 200, json: {} }));
    const provider = createMem0MemoryProvider({ apiKey: "k", fetch });

    await expect(
      provider.remember({
        tenantId: "",
        principalId: "p",
        text: "x",
      }),
    ).rejects.toThrow(/tenantId/);

    await expect(
      provider.recall({
        tenantId: "t",
        principalId: "",
        query: "q",
      }),
    ).rejects.toThrow(/principalId/);

    expect(calls).toHaveLength(0);
  });

  it("throws on non-OK HTTP from Mem0", async () => {
    const { fetch } = mockFetch(() => ({
      status: 401,
      json: { detail: "Unauthorized" },
    }));
    const provider = createMem0MemoryProvider({ apiKey: "bad", fetch });
    await expect(
      provider.remember({
        tenantId: "t",
        principalId: "p",
        text: "x",
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("tenant isolation: same principal different tenants → distinct user_id", async () => {
    const { fetch, calls } = mockFetch(() => ({
      status: 200,
      json: { results: [] },
    }));
    const provider = createMem0MemoryProvider({ apiKey: "k", fetch });

    await provider.recall({
      tenantId: "tenant-a",
      principalId: "alice",
      query: "prefs",
    });
    await provider.recall({
      tenantId: "tenant-b",
      principalId: "alice",
      query: "prefs",
    });

    const userIds = calls.map(
      (c) => (c.body as { filters: { user_id: string } }).filters.user_id,
    );
    expect(userIds).toEqual(["tenant-a::alice", "tenant-b::alice"]);
    expect(userIds[0]).not.toBe(userIds[1]);
  });
});

describe("parseSearchResults", () => {
  it("reads results[].memory", () => {
    expect(
      parseSearchResults({
        results: [{ memory: "a", score: 0.5 }],
      }),
    ).toEqual([{ text: "a", score: 0.5 }]);
  });

  it("handles empty / null", () => {
    expect(parseSearchResults(null)).toEqual([]);
    expect(parseSearchResults(undefined)).toEqual([]);
    expect(parseSearchResults({})).toEqual([]);
  });
});
