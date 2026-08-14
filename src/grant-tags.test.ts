import { describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";

import {
  canAccessDocument,
  filterAccessibleDocuments,
  ownerTag,
  resolveAccessTags,
  tenantTag,
} from "./grant-tags.ts";


describe("resolveAccessTags", () => {
  test("always includes owner tag", () => {
    expect(resolveAccessTags({ principalId: "u1", tenantId: "t1" })).toEqual([
      ownerTag("u1"),
    ]);
  });

  test("share.tenant mints tenant tag", () => {
    const tags = resolveAccessTags({
      principalId: "u1",
      tenantId: "t1",
      share: { tenant: true },
    });
    expect(tags).toContain(ownerTag("u1"));
    expect(tags).toContain(tenantTag("t1"));
  });

  test("share.principals mints peer owner tags", () => {
    const tags = resolveAccessTags({
      principalId: "u1",
      tenantId: "t1",
      share: { principals: ["alice", "bob"] },
    });
    expect(tags).toContain(ownerTag("u1"));
    expect(tags).toContain(ownerTag("alice"));
    expect(tags).toContain(ownerTag("bob"));
  });

  test("share.tags and explicit accessTags merge", () => {
    const tags = resolveAccessTags({
      principalId: "u1",
      tenantId: "t1",
      accessTags: ["memory.space:eng"],
      share: { tags: ["custom.project:ke"] },
    });
    expect(tags).toEqual(
      expect.arrayContaining([
        ownerTag("u1"),
        "memory.space:eng",
        "custom.project:ke",
      ]),
    );
  });
});

describe("canAccessDocument", () => {
  test("creator always allowed without grants on tags", async () => {
    const grants = createInMemoryGrantStore([]);
    const ok = await canAccessDocument({
      grants,
      tenantId: "t1",
      principalId: "u1",
      createdByPrincipalId: "u1",
      accessTags: [],
    });
    expect(ok).toBe(true);
  });

  test("peer needs grant on a tag", async () => {
    const grants = createInMemoryGrantStore([
      {
        id: "g1",
        principalId: "peer",
        resource: tenantTag("t1"),
        action: "search",
        effect: "allow",
        origin: "role",
        conditions: null,
        expiresAt: null,
        roleId: null,
      },
    ]);
    const denied = await canAccessDocument({
      grants: createInMemoryGrantStore([]),
      tenantId: "t1",
      principalId: "peer",
      createdByPrincipalId: "owner",
      accessTags: [tenantTag("t1")],
    });
    expect(denied).toBe(false);

    const allowed = await canAccessDocument({
      grants,
      tenantId: "t1",
      principalId: "peer",
      createdByPrincipalId: "owner",
      accessTags: [tenantTag("t1")],
    });
    expect(allowed).toBe(true);
  });
});

describe("filterAccessibleDocuments", () => {
  test("keeps creator and granted docs only", async () => {
    const grants = createInMemoryGrantStore([
      {
        id: "g1",
        principalId: "viewer",
        resource: "memory.space:eng",
        action: "search",
        effect: "allow",
        origin: "role",
        conditions: null,
        expiresAt: null,
        roleId: null,
      },
    ]);
    const docs = [
      {
        id: "a",
        createdByPrincipalId: "viewer",
        accessTags: [ownerTag("viewer")],
      },
      {
        id: "b",
        createdByPrincipalId: "other",
        accessTags: ["memory.space:eng"],
      },
      {
        id: "c",
        createdByPrincipalId: "other",
        accessTags: [ownerTag("other")],
      },
    ];
    const out = await filterAccessibleDocuments(docs, {
      grants,
      tenantId: "t1",
      principalId: "viewer",
    });
    expect(out.map((d) => d.id)).toEqual(["a", "b"]);
  });
});
