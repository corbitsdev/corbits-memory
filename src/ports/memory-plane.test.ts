/**
 * M3 MemoryProvider product wire: remember/recall, includeMemory on ask,
 * degrade on failure, default includeMemory=false.
 */
import { describe, expect, it } from "bun:test";
import {
  createInMemoryGrantStore,
  type GrantRule,
} from "@intx/authz";

import {
  createFakeDocumentStore,
  createFakeMemoryProvider,
  createKnowledgePlane,
  KnowledgeError,
} from "../index.ts";
import type { MemoryProvider } from "./types.ts";

const TENANT = "t_mem";
const PRINCIPAL = "p_mem";

function grant(action: string): GrantRule {
  return {
    id: `g-${action}`,
    resource: "knowledge",
    action,
    effect: "allow",
    origin: "role",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: PRINCIPAL,
  };
}

describe("MemoryProvider product wire (CL-5228)", () => {
  it("includeMemory defaults false — ask does not call recall", async () => {
    let recallCalls = 0;
    const memory: MemoryProvider = {
      async remember() {},
      async recall() {
        recallCalls += 1;
        return [{ text: "should not appear" }];
      },
    };
    const store = createFakeDocumentStore();
    const plane = createKnowledgePlane(
      undefined,
      {
        grantStore: createInMemoryGrantStore([grant("find")]),
        conditionRegistry: {},
      },
      {
        documentStore: store,
        memory,
        generate: async (msgs) => {
          const last = msgs[msgs.length - 1]?.content ?? "";
          return last.includes("Personal memory") ? "HAS_MEM" : "NO_MEM";
        },
      },
    );
    await plane.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      content: { title: "doc", text: "document body" },
    });
    const ans = await plane.ask({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "document",
    });
    expect(recallCalls).toBe(0);
    expect(ans.text).toBe("NO_MEM");
    await plane.close();
  });

  it("includeMemory true injects recalled texts into generate context", async () => {
    const memory = createFakeMemoryProvider();
    await memory.remember({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      text: "user prefers dark mode",
    });
    const store = createFakeDocumentStore();
    const plane = createKnowledgePlane(
      undefined,
      {
        grantStore: createInMemoryGrantStore([grant("find")]),
        conditionRegistry: {},
      },
      {
        documentStore: store,
        memory,
        generate: async (msgs) => {
          const last = msgs[msgs.length - 1]?.content ?? "";
          return last.includes("user prefers dark mode")
            ? "saw-memory"
            : "missed";
        },
      },
    );
    await plane.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      content: { title: "prefs", text: "settings doc" },
    });
    const ans = await plane.ask({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "dark",
      includeMemory: true,
    });
    expect(ans.text).toBe("saw-memory");
    await plane.close();
  });

  it("memory recall failure degrades with memory_unavailable", async () => {
    const memory: MemoryProvider = {
      async remember() {},
      async recall() {
        throw new Error("vendor down");
      },
    };
    const store = createFakeDocumentStore();
    const plane = createKnowledgePlane(
      undefined,
      {
        grantStore: createInMemoryGrantStore([grant("find")]),
        conditionRegistry: {},
      },
      {
        documentStore: store,
        memory,
        generate: async () => "docs-only [1]",
      },
    );
    await plane.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      content: { title: "d", text: "still answerable" },
    });
    const ans = await plane.ask({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "still answerable",
      includeMemory: true,
    });
    expect(ans.text).toContain("docs-only");
    expect(ans.degraded).toContain("memory_unavailable");
    await plane.close();
  });

  it("plane.remember writes; plane.recall reads", async () => {
    const memory = createFakeMemoryProvider();
    const plane = createKnowledgePlane(undefined, undefined, {
      documentStore: createFakeDocumentStore(),
      memory,
    });
    await plane.remember({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      text: "favorite color is blue",
    });
    const items = await plane.recall({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "favorite color",
    });
    expect(items.some((i) => i.text.includes("blue"))).toBe(true);
    await plane.close();
  });

  it("plane.remember without memory throws 501", async () => {
    const plane = createKnowledgePlane(undefined, undefined, {
      documentStore: createFakeDocumentStore(),
    });
    try {
      await plane.remember({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        text: "x",
      });
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KnowledgeError);
      expect((err as KnowledgeError).status).toBe(501);
    }
    await plane.close();
  });

  it("plane.recall without memory returns empty", async () => {
    const plane = createKnowledgePlane(undefined, undefined, {
      documentStore: createFakeDocumentStore(),
    });
    const items = await plane.recall({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "anything",
    });
    expect(items).toEqual([]);
    await plane.close();
  });
});
