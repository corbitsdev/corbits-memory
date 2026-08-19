import { describe, expect, it, mock } from "bun:test";

import type { RawSql } from "../db/client.ts";
import {
  isOwner,
  resolveDocumentOwner,
  resolveVersionOwner,
} from "./retention-ownership.ts";

const TENANT = "t1";

function fakeSql(rows: Array<{ created_by_principal_id: string | null }>) {
  const tag = mock(() => Promise.resolve(rows));
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
