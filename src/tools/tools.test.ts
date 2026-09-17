import { describe, expect, mock, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";

import { memoryAdd } from "./add.ts";
import { memorySearch } from "./search.ts";
import { memoryList } from "./list.ts";
import {
  createMemoryHttpClient,
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
    ...(overrides?.memoryFetch !== undefined
      ? { memoryFetch: overrides.memoryFetch }
      : {}),
  } as BaseEnv & MemoryToolEnv;
}

type Captured = {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
};

function makeFetchMock(
  respond: (req: Captured) => { status: number; json?: unknown; text?: string },
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
      const r = respond(captured);
      if (r.text !== undefined) {
        return new Response(r.text, {
          status: r.status,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response(JSON.stringify(r.json ?? {}), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  return { calls, fetchMock: fetchMock as unknown as typeof fetch };
}

describe("readMemoryToolEnv", () => {
  test("rejects empty credentials", () => {
    expect(() =>
      readMemoryToolEnv({
        memoryBaseUrl: "",
        memoryTenantId: TENANT,
        memoryAuthToken: TOKEN,
      }),
    ).toThrow(/memoryBaseUrl/);
    expect(() =>
      readMemoryToolEnv({
        memoryBaseUrl: BASE,
        memoryTenantId: "",
        memoryAuthToken: TOKEN,
      }),
    ).toThrow(/memoryTenantId/);
    expect(() =>
      readMemoryToolEnv({
        memoryBaseUrl: BASE,
        memoryTenantId: TENANT,
        memoryAuthToken: "",
      }),
    ).toThrow(/memoryAuthToken/);
  });
});

describe("createMemoryHttpClient", () => {
  test("POSTs add under tenant path with Bearer auth", async () => {
    const { calls, fetchMock } = makeFetchMock(() => ({
      status: 200,
      json: { documentId: "doc-1", versionId: "ver-1" },
    }));
    const client = createMemoryHttpClient({
      baseUrl: `${BASE}///`,
      tenantId: TENANT,
      authToken: TOKEN,
      fetch: fetchMock,
    });
    const out = await client.add({ title: "t", text: "body" });
    expect(out).toEqual({ documentId: "doc-1", versionId: "ver-1" });
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
  });

  test("surfaces non-2xx as Error", async () => {
    const { fetchMock } = makeFetchMock(() => ({
      status: 403,
      json: { error: "forbidden" },
    }));
    const client = createMemoryHttpClient({
      baseUrl: BASE,
      tenantId: TENANT,
      authToken: TOKEN,
      fetch: fetchMock,
    });
    await expect(client.search({ query: "x" })).rejects.toThrow(
      /memory HTTP 403/,
    );
  });

  test("rejects invalid JSON on 2xx", async () => {
    const { fetchMock } = makeFetchMock(() => ({
      status: 200,
      text: "not-json",
    }));
    const client = createMemoryHttpClient({
      baseUrl: BASE,
      tenantId: TENANT,
      authToken: TOKEN,
      fetch: fetchMock,
    });
    await expect(client.list()).rejects.toThrow(/invalid JSON/);
  });
});

describe("memoryAdd factory", () => {
  test("strips adversarial identity args from wire body", async () => {
    const { calls, fetchMock } = makeFetchMock(() => ({
      status: 200,
      json: { documentId: "doc-x" },
    }));
    const bundle = memoryAdd(toolEnv({ memoryFetch: fetchMock }));
    const result = await bundle.run(
      {
        id: "call-adv",
        name: "memory_add",
        arguments: {
          title: "note",
          text: "hello",
          tenantId: "evil-tenant",
          principalId: "evil-principal",
          tenant_id: "evil",
          principal_id: "evil",
        },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(calls[0]!.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ title: "note", text: "hello" });
    expect(calls[0]!.url).toContain(`/tenants/${TENANT}/`);
  });

  test("rebuilds share without nested extras", async () => {
    const { calls, fetchMock } = makeFetchMock(() => ({
      status: 200,
      json: { documentId: "doc-share" },
    }));
    const bundle = memoryAdd(toolEnv({ memoryFetch: fetchMock }));
    const result = await bundle.run(
      {
        id: "call-share",
        name: "memory_add",
        arguments: {
          title: "note",
          text: "hello",
          share: {
            tenant: true,
            principalId: "nested-evil",
            authToken: "should-not-wire",
            tags: ["team:eng"],
          },
        },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(calls[0]!.body ?? "{}") as {
      share?: Record<string, unknown>;
    };
    expect(body.share).toEqual({ tenant: true, tags: ["team:eng"] });
    expect(body.share).not.toHaveProperty("principalId");
    expect(body.share).not.toHaveProperty("authToken");
  });

  test("rejects empty title", async () => {
    const { fetchMock } = makeFetchMock(() => ({
      status: 200,
      json: { documentId: "x" },
    }));
    const bundle = memoryAdd(toolEnv({ memoryFetch: fetchMock }));
    const result = await bundle.run(
      {
        id: "call-bad",
        name: "memory_add",
        arguments: { title: "", text: "body" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });
});

describe("memorySearch factory", () => {
  test("coerces string limit and rejects out-of-range", async () => {
    const { calls, fetchMock } = makeFetchMock(() => ({
      status: 200,
      json: { items: [] },
    }));
    const bundle = memorySearch(toolEnv({ memoryFetch: fetchMock }));
    const ok = await bundle.run(
      {
        id: "call-lim",
        name: "memory_search",
        arguments: { query: "q", limit: "5" },
      },
      new AbortController().signal,
    );
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({
      query: "q",
      limit: 5,
    });

    const bad = await bundle.run(
      {
        id: "call-lim-bad",
        name: "memory_search",
        arguments: { query: "q", limit: 99 },
      },
      new AbortController().signal,
    );
    expect(bad.isError).toBe(true);
  });

  test("strips adversarial identity args from search wire body", async () => {
    const { calls, fetchMock } = makeFetchMock(() => ({
      status: 200,
      json: { items: [] },
    }));
    const bundle = memorySearch(toolEnv({ memoryFetch: fetchMock }));
    const result = await bundle.run(
      {
        id: "call-search-adv",
        name: "memory_search",
        arguments: {
          query: "q",
          tenantId: "evil-tenant",
          principalId: "evil-principal",
          authToken: "nope",
        },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(calls[0]!.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ query: "q" });
    expect(calls[0]!.url).toContain(`/tenants/${TENANT}/`);
  });
});

describe("memoryList factory", () => {
  test("ignores adversarial identity args on list", async () => {
    const { calls, fetchMock } = makeFetchMock(() => ({
      status: 200,
      json: { events: [] },
    }));
    const bundle = memoryList(toolEnv({ memoryFetch: fetchMock }));
    const result = await bundle.run(
      {
        id: "call-list-adv",
        name: "memory_list",
        arguments: {
          limit: 3,
          tenantId: "evil",
          principalId: "evil",
        },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(calls[0]!.url).toBe(
      `${BASE}/api/tenants/${TENANT}/memory/list?limit=3`,
    );
    expect(calls[0]!.url).not.toContain("evil");
  });

  test("HTTP error becomes isError tool result", async () => {
    const { fetchMock } = makeFetchMock(() => ({
      status: 401,
      json: { error: "unauthorized" },
    }));
    const bundle = memoryList(toolEnv({ memoryFetch: fetchMock }));
    const result = await bundle.run(
      { id: "call-4", name: "memory_list", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  });
});
