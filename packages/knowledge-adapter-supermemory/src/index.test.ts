import { describe, expect, it, mock } from "bun:test";

import {
  containerTag,
  createSupermemoryDocumentStore,
  createSupermemoryMemoryProvider,
} from "./index.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("containerTag", () => {
  it("maps tenant + principal with length prefixes", () => {
    expect(containerTag("acme", "alice")).toBe("t4_acme_u5_alice");
    expect(containerTag("org-1", "user-42")).toBe("t5_org-1_u7_user-42");
  });

  it("produces distinct tags per tenant for the same principal", () => {
    const a = containerTag("tenant-a", "user-1");
    const b = containerTag("tenant-b", "user-1");
    expect(a).toBe("t8_tenant-a_u6_user-1");
    expect(b).toBe("t8_tenant-b_u6_user-1");
    expect(a).not.toBe(b);
  });

  it("is injective when ids contain delimiter sequences", () => {
    const a = containerTag("x_u_y", "z");
    const b = containerTag("x", "y_u_z");
    expect(a).not.toBe(b);
    expect(a).toBe("t5_x_u_y_u1_z");
    expect(b).toBe("t1_x_u5_y_u_z");
  });

  it("rejects empty tenantId or principalId", () => {
    expect(() => containerTag("", "alice")).toThrow(/non-empty/);
    expect(() => containerTag("acme", "")).toThrow(/non-empty/);
    expect(() => containerTag("", "")).toThrow(/non-empty/);
    expect(() => containerTag("  ", "alice")).toThrow(/non-empty/);
  });
});

describe("createSupermemoryDocumentStore", () => {
  it("rejects empty identity on add", async () => {
    const fetchImpl = mock(() => Promise.resolve(jsonResponse({ id: "x" })));
    const store = createSupermemoryDocumentStore({
      apiKey: "test-key",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      store.add({
        tenantId: "",
        principalId: "alice",
        title: "t",
        text: "hello",
        visibility: { mode: "tenant" },
      }),
    ).rejects.toThrow(/non-empty/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("add posts to /v3/documents with containerTag and returns documentId", async () => {
    const fetchImpl = mock((url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.supermemory.ai/v3/documents");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer test-key");
      const body = JSON.parse(init?.body as string) as {
        content: string;
        containerTag: string;
        metadata?: Record<string, string>;
      };
      expect(body.containerTag).toBe("t4_acme_u5_alice");
      expect(body.content).toContain("# Prefs");
      expect(body.content).toContain("prefers dark mode");
      expect(body.metadata?.title).toBe("Prefs");
      return Promise.resolve(jsonResponse({ id: "doc_1", status: "queued" }));
    });

    const store = createSupermemoryDocumentStore({
      apiKey: "test-key",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const { documentId } = await store.add({
      tenantId: "acme",
      principalId: "alice",
      title: "Prefs",
      text: "prefers dark mode",
      visibility: { mode: "private", principalIds: ["alice"] },
    });

    expect(documentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("find uses hybrid searchMode and maps hits", async () => {
    const fetchImpl = mock((url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.supermemory.ai/v4/search");
      const body = JSON.parse(init?.body as string) as {
        q: string;
        containerTag: string;
        searchMode: string;
        limit?: number;
      };
      expect(body.q).toBe("preferences");
      expect(body.containerTag).toBe("t4_acme_u5_alice");
      expect(body.searchMode).toBe("hybrid");
      expect(body.limit).toBe(3);
      return Promise.resolve(
        jsonResponse({
          results: [
            {
              id: "mem_1",
              chunk: "# Theme\n\nUser prefers dark mode",
              similarity: 0.92,
              metadata: { documentId: "d1" },
            },
          ],
        }),
      );
    });

    const store = createSupermemoryDocumentStore({
      apiKey: "test-key",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const result = await store.find({
      tenantId: "acme",
      principalId: "alice",
      query: "preferences",
      limit: 3,
      includeEvidence: true,
    });

    expect(result.evidence).toBe("weak");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.documentId).toBe("d1");
    expect(result.items[0]!.title).toBe("Theme");
    expect(result.items[0]!.citation.adapter).toBe("supermemory");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("scopes container tags distinctly per tenant on add", async () => {
    const tags: string[] = [];
    const fetchImpl = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { containerTag: string };
      tags.push(body.containerTag);
      return Promise.resolve(jsonResponse({ id: "x" }));
    });

    const store = createSupermemoryDocumentStore({
      apiKey: "test-key",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await store.add({
      tenantId: "tenant-a",
      principalId: "user-1",
      title: "a",
      text: "fact a",
      visibility: { mode: "tenant" },
    });
    await store.add({
      tenantId: "tenant-b",
      principalId: "user-1",
      title: "b",
      text: "fact b",
      visibility: { mode: "tenant" },
    });

    expect(tags).toEqual(["t8_tenant-a_u6_user-1", "t8_tenant-b_u6_user-1"]);
  });

  it("recent returns empty; close is a no-op", async () => {
    const store = createSupermemoryDocumentStore({
      apiKey: "test-key",
      fetch: mock(() => Promise.resolve(jsonResponse({}))) as unknown as typeof fetch,
    });
    expect(
      await store.recent({ tenantId: "t", principalId: "u" }),
    ).toEqual([]);
    await store.close();
  });

  it("throws when apiKey is empty", () => {
    expect(() => createSupermemoryDocumentStore({ apiKey: "" })).toThrow(
      /apiKey/,
    );
  });
});

describe("createSupermemoryMemoryProvider (legacy)", () => {
  it("recall always sends searchMode: memories", async () => {
    const fetchImpl = mock((url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.supermemory.ai/v4/search");
      const body = JSON.parse(init?.body as string) as {
        searchMode: string;
      };
      expect(body.searchMode).toBe("memories");
      return Promise.resolve(
        jsonResponse({
          results: [
            {
              id: "mem_1",
              memory: "User prefers dark mode",
              similarity: 0.92,
            },
          ],
        }),
      );
    });

    const provider = createSupermemoryMemoryProvider({
      apiKey: "test-key",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const hits = await provider.recall({
      tenantId: "acme",
      principalId: "alice",
      query: "preferences",
      limit: 3,
    });

    expect(hits).toEqual([{ text: "User prefers dark mode", score: 0.92 }]);
  });
});
