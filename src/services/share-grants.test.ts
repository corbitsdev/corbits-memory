import { describe, expect, it } from "bun:test";
import { authorize } from "@intx/authz";

import {
  buildShareGrants,
  documentTag,
  materializeShareGrants,
  MEMORY_SHARE_CONDITION_REGISTRY,
  shareWidenReceipt,
  splitAudienceWiden,
} from "./share-grants.ts";
import { createInMemoryWritableGrantStore } from "../ports/writable-grant-store.ts";
import { canAccessDocument } from "../grant-tags.ts";

describe("documentTag", () => {
  it("scopes resource to the document id", () => {
    expect(documentTag("kdoc_1")).toBe("memory.doc:kdoc_1");
  });
});

describe("buildShareGrants", () => {
  it("emits one allow/search grant per peer on the document tag", () => {
    const grants = buildShareGrants({
      tenantId: "t1",
      sharedByPrincipalId: "alice",
      documentId: "kdoc_1",
      sourceVersionId: "kver_1",
      share: { principals: ["bob", "carol"] },
    });
    expect(grants).toHaveLength(2);
    expect(grants.every((g) => g.resource === "memory.doc:kdoc_1")).toBe(true);
    expect(grants.every((g) => g.action === "search" && g.effect === "allow")).toBe(
      true,
    );
    expect(grants.map((g) => g.principalId).sort()).toEqual(["bob", "carol"]);
    expect(grants[0]?.conditions?.memoryShare).toEqual({
      sharedBy: "alice",
      sourceVersionId: "kver_1",
      documentId: "kdoc_1",
      tenantId: "t1",
    });
    expect(grants[0]?.origin).toBe("system");
  });

  it("skips the sharer themselves and empty principals", () => {
    const grants = buildShareGrants({
      tenantId: "t1",
      sharedByPrincipalId: "alice",
      documentId: "kdoc_1",
      sourceVersionId: "kver_1",
      share: { principals: ["alice", "  ", "bob"] },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]?.principalId).toBe("bob");
  });

  it("returns empty when only tenant/tags sugar is set", () => {
    const grants = buildShareGrants({
      tenantId: "t1",
      sharedByPrincipalId: "alice",
      documentId: "kdoc_1",
      sourceVersionId: "kver_1",
      share: { tenant: true, tags: ["memory.space:eng"] },
    });
    expect(grants).toHaveLength(0);
  });
});

describe("materializeShareGrants + canAccessDocument", () => {
  it("peer can search after materialize; non-peer cannot", async () => {
    const store = createInMemoryWritableGrantStore();
    await materializeShareGrants(store, {
      tenantId: "t1",
      sharedByPrincipalId: "alice",
      documentId: "kdoc_1",
      sourceVersionId: "kver_1",
      share: { principals: ["bob"] },
    });

    const tags = ["memory.owner:alice", documentTag("kdoc_1")];
    const registry = MEMORY_SHARE_CONDITION_REGISTRY;

    expect(
      await canAccessDocument({
        grants: store,
        tenantId: "t1",
        principalId: "bob",
        createdByPrincipalId: "alice",
        accessTags: tags,
        conditionRegistry: registry,
      }),
    ).toBe(true);

    expect(
      await canAccessDocument({
        grants: store,
        tenantId: "t1",
        principalId: "eve",
        createdByPrincipalId: "alice",
        accessTags: tags,
        conditionRegistry: registry,
      }),
    ).toBe(false);

    // Creator still allowed without a grant.
    expect(
      await canAccessDocument({
        grants: store,
        tenantId: "t1",
        principalId: "alice",
        createdByPrincipalId: "alice",
        accessTags: tags,
      }),
    ).toBe(true);
  });

  it("embargo: expired grant does not allow access", async () => {
    const store = createInMemoryWritableGrantStore();
    await store.putGrant({
      id: "g_expired",
      principalId: "bob",
      resource: "memory.doc:kdoc_1",
      action: "search",
      effect: "allow",
      origin: "system",
      roleId: null,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      conditions: null,
    });

    const decision = await authorize(
      store,
      "bob",
      "t1",
      "memory.doc:kdoc_1",
      "search",
    );
    expect(decision.effect).toBe(null);

    expect(
      await canAccessDocument({
        grants: store,
        tenantId: "t1",
        principalId: "bob",
        createdByPrincipalId: "alice",
        accessTags: [documentTag("kdoc_1")],
      }),
    ).toBe(false);
  });
});

describe("splitAudienceWiden", () => {
  it("keeps source tags, flags new ones for approval", () => {
    const { allowed, needsApproval } = splitAudienceWiden(
      ["memory.owner:alice", "memory.space:eng"],
      ["memory.owner:alice", "memory.space:eng", "memory.tenant:t1"],
    );
    expect(allowed).toEqual(["memory.owner:alice", "memory.space:eng"]);
    expect(needsApproval).toEqual(["memory.tenant:t1"]);
  });
});

describe("shareWidenReceipt", () => {
  it("records approver, tags, and source version", () => {
    const receipt = shareWidenReceipt({
      approvedBy: "alice",
      tags: ["memory.tenant:t1"],
      sourceVersionId: "kver_1",
      approvedAt: new Date("2026-07-20T00:00:00Z"),
    });
    expect(receipt).toEqual({
      approvedBy: "alice",
      approvedAt: "2026-07-20T00:00:00.000Z",
      tags: ["memory.tenant:t1"],
      sourceVersionId: "kver_1",
    });
  });
});
