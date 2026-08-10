import { describe, expect, it } from "bun:test";

import type { MemoryHttpClient } from "../tools/client.ts";
import { RESIDENT_DISTILLER_AGENT_ID } from "./constants.ts";
import { runDistillTick } from "./tick.ts";

function fakeClient(opts: {
  page: unknown;
  adds?: unknown[];
}): MemoryHttpClient {
  const adds = opts.adds ?? [];
  return {
    async add(body) {
      adds.push(body);
      return { documentId: "d_new", versionId: "v_new" };
    },
    async search() {
      return { items: [] };
    },
    async list() {
      return { events: [] };
    },
    async feed() {
      return opts.page;
    },
  };
}

describe("runDistillTick", () => {
  it("writes claims and advances cursor", async () => {
    const adds: unknown[] = [];
    const client = fakeClient({
      adds,
      page: {
        entries: [
          {
            feedSeq: 1,
            versionId: "v1",
            documentId: "d1",
            kind: "note",
            title: "Raw",
            status: "active",
            createdByKind: "human",
            generatorAgentId: null,
            provenance: "stated",
            occurredAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
            accessTags: ["memory.owner:u1"],
          },
        ],
        nextCursor: 1,
      },
    });

    const result = await runDistillTick({
      client,
      after: 0,
      distill: async () => ({
        action: "write",
        title: "Claim",
        text: "Durable fact",
        temporalClass: "state",
      }),
    });

    expect(result.nextCursor).toBe(1);
    expect(result.wrote).toBe(1);
    expect(result.skipped).toBe(0);
    expect(adds).toHaveLength(1);
    const body = adds[0] as Record<string, unknown>;
    expect(body["generator_agent_id"]).toBe(RESIDENT_DISTILLER_AGENT_ID);
    expect(body["derived_from"]).toEqual(["v1"]);
    expect(body["access_tags"]).toEqual(["memory.owner:u1"]);
  });

  it("fail-soft poisons and still advances", async () => {
    const client = fakeClient({
      page: {
        entries: [
          {
            feedSeq: 3,
            versionId: "v3",
            documentId: "d3",
            kind: "note",
            title: "Bad",
            status: "active",
            createdByKind: "human",
            generatorAgentId: null,
            provenance: "stated",
            occurredAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
            accessTags: [],
          },
        ],
        nextCursor: 3,
      },
    });

    const result = await runDistillTick({
      client,
      after: 2,
      distill: async () => {
        throw new Error("model blew up");
      },
    });

    expect(result.poisoned).toBe(1);
    expect(result.wrote).toBe(0);
    expect(result.nextCursor).toBe(3);
  });

  it("skips when distill returns skip", async () => {
    const client = fakeClient({
      page: {
        entries: [
          {
            feedSeq: 2,
            versionId: "v2",
            documentId: "d2",
            kind: "note",
            title: "Noise",
            status: "active",
            createdByKind: "human",
            generatorAgentId: null,
            provenance: "stated",
            occurredAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
            accessTags: [],
          },
        ],
        nextCursor: 2,
      },
    });

    const result = await runDistillTick({
      client,
      distill: async () => ({ action: "skip" }),
    });
    expect(result.skipped).toBe(1);
    expect(result.wrote).toBe(0);
  });
});
