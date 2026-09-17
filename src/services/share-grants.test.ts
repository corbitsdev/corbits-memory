import { describe, expect, it } from "bun:test";
import {
  buildShareGrants,
  documentTag,
  materializeShareGrants,
  MEMORY_SHARE_CONDITION_REGISTRY,
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
});