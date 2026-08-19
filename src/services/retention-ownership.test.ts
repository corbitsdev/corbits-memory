import { describe, expect, it, mock } from "bun:test";

import type { RawSql } from "../db/client.ts";
import {
  isOwner,
  resolveDocumentOwner,
  resolveVersionOwner,
} from "./retention-ownership.ts";

const TENANT = "t1";
const OTHER_TENANT = "t2";

function fakeSql(rows: Array<{ created_by_principal_id: string | null }>) {
  const tag = mock(() => Promise.resolve(rows));
  return tag as unknown as RawSql;
}

/**
 * A fake sql tag that actually filters by the bound values, the way the real
 * `WHERE tenant_id = ... AND document_id/id = ...` query does — so a test
 * can prove tenant scoping is enforced (defense in depth, mirroring the
 * destructive queries in retention.ts) rather than assume it from a
 * single-tenant fixture that would pass either way.
 */
function fakeScopedSql(
  rows: Array<{
    tenantId: string;
    id: string;
    created_by_principal_id: string | null;
  }>,
) {
  const tag = mock((_strings: TemplateStringsArray, ...values: unknown[]) => {
    // Fails loudly (not silently) if the query stops binding exactly two
    // values — e.g. if a future edit drops the tenant_id predicate, the
    // query would interpolate only the id and this mock would no longer be
    // exercising real tenant scoping.
    if (values.length !== 2) {
      throw new Error(
        `expected exactly 2 bound values (tenantId, id); got ${values.length}`,
      );
    }
    const [tenantId, id] = values as [string, string];
    return Promise.resolve(
      rows
        .filter((r) => r.tenantId === tenantId && r.id === id)
        .map((r) => ({ created_by_principal_id: r.created_by_principal_id })),
    );
  });
  return tag as unknown as RawSql;
}

describe("resolveDocumentOwner", () => {
  it("returns exists:false for a document with no versions", async () => {
    const sql = fakeSql([]);
    const result = await resolveDocumentOwner(sql, {
      tenantId: TENANT,
      documentId: "doc-missing",
    });
    expect(result).toEqual({ exists: false, ownerId: null });
  });

  it("returns the creator of the document's first version", async () => {
    const sql = fakeSql([{ created_by_principal_id: "alice" }]);
    const result = await resolveDocumentOwner(sql, {
      tenantId: TENANT,
      documentId: "doc-1",
    });
    expect(result).toEqual({ exists: true, ownerId: "alice" });
  });

  it("treats a null creator (legacy row) as exists with no owner", async () => {
    const sql = fakeSql([{ created_by_principal_id: null }]);
    const result = await resolveDocumentOwner(sql, {
      tenantId: TENANT,
      documentId: "doc-1",
    });
    expect(result).toEqual({ exists: true, ownerId: null });
  });

  it("does not find tenant A's document under tenant B's tenantId — cross-tenant lookup is exists:false", async () => {
    const sql = fakeScopedSql([
      { tenantId: TENANT, id: "doc-1", created_by_principal_id: "alice" },
    ]);
    const result = await resolveDocumentOwner(sql, {
      tenantId: OTHER_TENANT,
      documentId: "doc-1",
    });
    expect(result).toEqual({ exists: false, ownerId: null });
  });
});

describe("resolveVersionOwner", () => {
  it("returns exists:false for an unknown version", async () => {
    const sql = fakeSql([]);
    const result = await resolveVersionOwner(sql, {
      tenantId: TENANT,
      versionId: "ver-missing",
    });
    expect(result).toEqual({ exists: false, ownerId: null });
  });

  it("returns the version's own creator", async () => {
    const sql = fakeSql([{ created_by_principal_id: "bob" }]);
    const result = await resolveVersionOwner(sql, {
      tenantId: TENANT,
      versionId: "ver-1",
    });
    expect(result).toEqual({ exists: true, ownerId: "bob" });
  });

  it("does not find tenant A's version under tenant B's tenantId — cross-tenant lookup is exists:false", async () => {
    // The security property this proves: tenant B cannot forget/purge/change
    // retention on tenant A's version merely by guessing its id — the tenant
    // filter in the ownership query is independent, defense-in-depth
    // scoping alongside the tenant filter the destructive queries also carry.
    const sql = fakeScopedSql([
      { tenantId: TENANT, id: "ver-1", created_by_principal_id: "bob" },
    ]);
    const result = await resolveVersionOwner(sql, {
      tenantId: OTHER_TENANT,
      versionId: "ver-1",
    });
    expect(result).toEqual({ exists: false, ownerId: null });
  });
});

describe("isOwner", () => {
  it("is false when the row does not exist, even if ownerId happens to match", () => {
    expect(isOwner({ exists: false, ownerId: "alice" }, "alice")).toBe(false);
  });

  it("is false when the row exists but a different principal created it", () => {
    expect(isOwner({ exists: true, ownerId: "alice" }, "mallory")).toBe(false);
  });

  it("is true only for the exact creator", () => {
    expect(isOwner({ exists: true, ownerId: "alice" }, "alice")).toBe(true);
  });
});
