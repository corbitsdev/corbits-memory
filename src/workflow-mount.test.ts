import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { Memory } from "./memory.ts";
import {
  mountWorkflowMemory,
  type AgentTokenAuth,
  type ResolvedWorkflowRunScope,
  type WorkflowMemoryEnv,
} from "./workflow-mount.ts";

const RUN_SCOPE: ResolvedWorkflowRunScope = {
  tenantId: "acme",
  principalId: "agent-1",
  runId: "run-1",
};

const ADDRESS = "run-1@acme.example.com";
const AGENT_TOKEN = "agent-token";

const agentHeaders = {
  authorization: `Bearer ${AGENT_TOKEN}`,
  "x-workflow-run-address": ADDRESS,
};

function fakeMemory(seen: Record<string, unknown>[]): Memory {
  type Params = Record<string, unknown>;
  return {
    capabilities: { embeddingsConfigured: false },
    add: async (params: Params) => {
      seen.push({ verb: "add", ...params });
      return { documentId: "doc_1", versionId: "ver_1" };
    },
    search: async (params: Params) => {
      seen.push({ verb: "search", ...params });
      return { items: [] };
    },
    list: async (params: Params) => {
      seen.push({ verb: "list", ...params });
      return [];
    },
    feed: async (params: Params) => {
      seen.push({ verb: "feed", ...params });
      return { entries: [], nextCursor: null };
    },
    close: async () => {},
  } as unknown as Memory;
}

function agentTokenAuth(overrides: Partial<AgentTokenAuth> = {}): AgentTokenAuth {
  return {
    verify: (ctx) => {
      const c = ctx as { req: { header(name: string): string | undefined } };
      return c.req.header("authorization") === `Bearer ${AGENT_TOKEN}`
        ? { tenantId: "acme", definitionId: "def-1" }
        : undefined;
    },
    resolveRun: (address) => (address === ADDRESS ? RUN_SCOPE : null),
    ...overrides,
  };
}

function host(seen: Record<string, unknown>[], agentToken: AgentTokenAuth = agentTokenAuth()) {
  return mountWorkflowMemory(new Hono<WorkflowMemoryEnv>(), {
    memory: fakeMemory(seen),
    agentToken,
  });
}

describe("agent-token authentication", () => {
  test("an agent bearer authenticates and scopes to the run's tenant", async () => {
    const seen: Record<string, unknown>[] = [];
    const res = await host(seen).request("/list", { headers: agentHeaders });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ verb: "list", tenantId: "acme", principalId: "agent-1" });
  });

  test("no bearer at all is refused", async () => {
    const seen: Record<string, unknown>[] = [];
    const res = await host(seen).request("/list", {
      headers: { "x-workflow-run-address": ADDRESS },
    });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("a token from another tenant is refused", async () => {
    const seen: Record<string, unknown>[] = [];
    const app = host(
      seen,
      agentTokenAuth({ verify: () => ({ tenantId: "other", definitionId: "def-1" }) }),
    );
    const res = await app.request("/list", { headers: agentHeaders });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("an address that names no run is refused", async () => {
    const seen: Record<string, unknown>[] = [];
    const res = await host(seen).request("/list", {
      headers: { ...agentHeaders, "x-workflow-run-address": "run-9@acme.example.com" },
    });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

describe("the routes the memory tools call", () => {
  test("add scopes to the run and never takes identity from the body", async () => {
    const seen: Record<string, unknown>[] = [];
    const res = await host(seen).request("/add", {
      method: "POST",
      headers: { "content-type": "application/json", ...agentHeaders },
      body: JSON.stringify({ title: "T", text: "b", tenantId: "spoofed" }),
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      verb: "add",
      tenantId: "acme",
      principalId: "agent-1",
      content: { title: "T", text: "b" },
    });
  });

  test("search forwards the parsed filters", async () => {
    const seen: Record<string, unknown>[] = [];
    const res = await host(seen).request("/search", {
      method: "POST",
      headers: { "content-type": "application/json", ...agentHeaders },
      body: JSON.stringify({ query: "q", limit: 3, entity_ids: ["e1"] }),
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ verb: "search", query: "q", limit: 3, entityIds: ["e1"] });
  });

  test("feed forwards the cursor and generator exclusion", async () => {
    const seen: Record<string, unknown>[] = [];
    const res = await host(seen).request(
      "/feed?after=4&limit=10&exclude_generator=resident-distiller",
      { headers: agentHeaders },
    );
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      verb: "feed",
      after: 4,
      limit: 10,
      excludeGenerator: "resident-distiller",
    });
  });

  test("a malformed add body is rejected before the plane is touched", async () => {
    const seen: Record<string, unknown>[] = [];
    const res = await host(seen).request("/add", {
      method: "POST",
      headers: { "content-type": "application/json", ...agentHeaders },
      body: JSON.stringify({ title: "T" }),
    });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});
