import { describe, expect, it, mock } from "bun:test";

import {
  containerTag,
  createSupermemoryMemoryProvider,
} from "./index.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("containerTag", () => {
  it("maps tenant + principal to t_{tenant}_u_{principal}", () => {
    expect(containerTag("acme", "alice")).toBe("t_acme_u_alice");
    expect(containerTag("org-1", "user-42")).toBe("t_org-1_u_user-42");
  });

  it("produces distinct tags per tenant for the same principal", () => {
    const a = containerTag("tenant-a", "user-1");
    const b = containerTag("tenant-b", "user-1");
    expect(a).toBe("t_tenant-a_u_user-1");
    expect(b).toBe("t_tenant-b_u_user-1");
    expect(a).not.toBe(b);
  });

  it("rejects empty tenantId or principalId", () => {
    expect(() => containerTag("", "alice")).toThrow(/non-empty/);
    expect(() => containerTag("acme", "")).toThrow(/non-empty/);
    expect(() => containerTag("", "")).toThrow(/non-empty/);
  });
});

describe("createSupermemoryMemoryProvider", () => {
  it("rejects empty identity on remember", async () => {
    const fetchImpl = mock(() => Promise.resolve(jsonResponse({ id: "x" })));
    const provider = createSupermemoryMemoryProvider({
      apiKey: "test-key",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      provider.remember({
        tenantId: "",
        principalId: "alice",
        text: "hello",
      }),
    ).rejects.toThrow(/non-empty/);

    await expect(
      provider.remember({
        tenantId: "acme",
        principalId: "",
        text: "hello",
      }),
    ).rejects.toThrow(/non-empty/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects empty identity on recall", async () => {
    const fetchImpl = mock(() => Promise.resolve(jsonResponse({ results: [] })));
    const provider = createSupermemoryMemoryProvider({
      apiKey: "test-key",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      provider.recall({
        tenantId: "",
        principalId: "alice",
        query: "prefs",
      }),
    ).rejects.toThrow(/non-empty/);

    await expect(
      provider.recall({
        tenantId: "acme",
        principalId: "",
        query: "prefs",
      }),
    ).rejects.toThrow(/non-empty/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("remember posts to /v3/documents with containerTag", async () => {
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
      expect(body.content).toBe("prefers dark mode");
      expect(body.containerTag).toBe("t_acme_u_alice");
      expect(body.metadata).toEqual({ source: "chat" });
      return Promise.resolve(jsonResponse({ id: "doc_1", status: "queued" }));
    });

    const provider = createSupermemoryMemoryProvider({
      apiKey: "test-key",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await provider.remember({
      tenantId: "acme",
      principalId: "alice",
      text: "prefers dark mode",
      metadata: { source: "chat" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recall always sends searchMode: memories (never default)", async () => {
    const fetchImpl = mock((url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.supermemory.ai/v4/search");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init?.body as string) as {
        q: string;
        containerTag: string;
        searchMode: string;
        limit?: number;
      };
      expect(body.q).toBe("preferences");
      expect(body.containerTag).toBe("t_acme_u_alice");
      expect(body.searchMode).toBe("memories");
      expect(body.limit).toBe(3);
      // Must not omit searchMode (would fall through to API default).
      expect("searchMode" in body).toBe(true);
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

    expect(hits).toEqual([
      { text: "User prefers dark mode", score: 0.92 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("scopes container tags distinctly per tenant on remember", async () => {
    const tags: string[] = [];
    const fetchImpl = mock((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { containerTag: string };
      tags.push(body.containerTag);
      return Promise.resolve(jsonResponse({ id: "x" }));
    });

    const provider = createSupermemoryMemoryProvider({
      apiKey: "test-key",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await provider.remember({
      tenantId: "tenant-a",
      principalId: "user-1",
      text: "fact a",
    });
    await provider.remember({
      tenantId: "tenant-b",
      principalId: "user-1",
      text: "fact b",
    });

    expect(tags).toEqual(["t_tenant-a_u_user-1", "t_tenant-b_u_user-1"]);
  });

  it("uses custom baseUrl when provided", async () => {
    const fetchImpl = mock((url: string) => {
      expect(url).toBe("http://localhost:6767/v4/search");
      return Promise.resolve(jsonResponse({ results: [] }));
    });

    const provider = createSupermemoryMemoryProvider({
      apiKey: "test-key",
      baseUrl: "http://localhost:6767/",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await provider.recall({
      tenantId: "t",
      principalId: "u",
      query: "q",
    });
  });

  it("throws when apiKey is empty", () => {
    expect(() =>
      createSupermemoryMemoryProvider({ apiKey: "" }),
    ).toThrow(/apiKey/);
  });
});
