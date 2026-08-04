import { describe, expect, it } from "bun:test";

import {
  createMem0DocumentStore,
  parseFindResults,
} from "./create-mem0-document-store.ts";

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
    input: string | URL | Request,
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

describe("createMem0DocumentStore", () => {
  it("rejects missing apiKey", () => {
    expect(() => createMem0DocumentStore({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("add posts mapped user_id and returns documentId", async () => {
    const { fetch, calls } = mockFetch(() => ({
      status: 200,
      json: { event_id: "e1", status: "PENDING" },
    }));
    const store = createMem0DocumentStore({ apiKey: "test-key", fetch });

    const { documentId } = await store.add({
      tenantId: "t1",
      principalId: "p1",
      title: "Prefs",
      text: "Prefers dark mode",
      accessTags: ["memory.owner:p1"],
    });

    expect(documentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.mem0.ai/v3/memories/add/");
    const body = call.body as Record<string, unknown>;
    expect(body.user_id).toBe("2:t1:2:p1");
    expect(body.user_id).not.toBe("p1");
    expect(body.infer).toBe(false);
    const messages = body.messages as Array<{ content: string }>;
    expect(messages[0]!.content).toContain("# Prefs");
    expect(messages[0]!.content).toContain("Prefers dark mode");
    expect(messages[0]!.content).toContain(documentId);
    const meta = body.metadata as Record<string, string>;
    expect(meta.documentId).toBe(documentId);
    expect(meta.title).toBe("Prefs");
  });

  it("find scopes search by mapped user_id and maps hits", async () => {
    const { fetch, calls } = mockFetch(() => ({
      status: 200,
      json: {
        results: [
          {
            id: "m1",
            memory: "# Home\n\nLives in SF",
            score: 0.91,
            metadata: { documentId: "doc-1", externalRef: "ref-1" },
          },
        ],
      },
    }));
    const store = createMem0DocumentStore({
      apiKey: "k",
      baseUrl: "https://mem0.example.com/",
      fetch,
    });

    const result = await store.find({
      tenantId: "acme",
      principalId: "bob",
      query: "where do I live?",
      limit: 3,
      includeEvidence: true,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://mem0.example.com/v3/memories/search/");
    const body = call.body as Record<string, unknown>;
    expect(body.filters).toEqual({ user_id: "4:acme:3:bob" });
    expect(body.top_k).toBe(3);

    expect(result.evidence).toBe("weak");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.documentId).toBe("doc-1");
    expect(result.items[0]!.title).toBe("Home");
    expect(result.items[0]!.snippet).toContain("Lives in SF");
    expect(result.items[0]!.citation.adapter).toBe("mem0");
    expect(result.items[0]!.citation.external_ref).toBe("ref-1");
  });

  it("add/find reject empty identity", async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 200, json: {} }));
    const store = createMem0DocumentStore({ apiKey: "k", fetch });

    await expect(
      store.add({
        tenantId: "",
        principalId: "p",
        title: "t",
        text: "x",
        accessTags: ["memory.owner:p"],
      }),
    ).rejects.toThrow(/tenantId/);

    await expect(
      store.find({
        tenantId: "t",
        principalId: "",
        query: "q",
      }),
    ).rejects.toThrow(/principalId/);

    expect(calls).toHaveLength(0);
  });

  it("tenant isolation: same principal different tenants → distinct user_id", async () => {
    const { fetch, calls } = mockFetch(() => ({
      status: 200,
      json: { results: [] },
    }));
    const store = createMem0DocumentStore({ apiKey: "k", fetch });

    await store.find({
      tenantId: "tenant-a",
      principalId: "alice",
      query: "prefs",
    });
    await store.find({
      tenantId: "tenant-b",
      principalId: "alice",
      query: "prefs",
    });

    const userIds = calls.map(
      (c) => (c.body as { filters: { user_id: string } }).filters.user_id,
    );
    expect(userIds).toEqual(["8:tenant-a:5:alice", "8:tenant-b:5:alice"]);
    expect(userIds[0]).not.toBe(userIds[1]);
  });

  it("recent returns empty list; close is a no-op", async () => {
    const store = createMem0DocumentStore({
      apiKey: "k",
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    });

    expect(
      await store.recent({
        tenantId: "t",
        principalId: "p",
      }),
    ).toEqual([]);
    await store.close();
  });
});

describe("parseFindResults", () => {
  it("reads results[].memory with metadata documentId", () => {
    const items = parseFindResults({
      results: [
        {
          memory: "# Note\n\nbody",
          score: 0.5,
          metadata: { documentId: "d1" },
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.documentId).toBe("d1");
    expect(items[0]!.title).toBe("Note");
  });

  it("handles empty / null", () => {
    expect(parseFindResults(null)).toEqual([]);
    expect(parseFindResults(undefined)).toEqual([]);
    expect(parseFindResults({})).toEqual([]);
  });
});
