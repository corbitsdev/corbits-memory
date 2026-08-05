/**
 * Product path: DocumentStore-backed plane (add / search / list).
 * MemoryProvider / ask / remember / recall are not on the product surface.
 */
import { describe, expect, it } from "bun:test";
import {
  createInMemoryGrantStore,
  type GrantRule,
} from "@intx/authz";

import {
  createFakeDocumentStore,
  createMemory,
} from "../index.ts";

const TENANT = "t_mem";
const PRINCIPAL = "p_mem";

function grant(action: string): GrantRule {
  return {
    id: `g-${action}`,
    resource: "memory",
    action,
    effect: "allow",
    origin: "role",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: PRINCIPAL,
  };
}

describe("DocumentStore product plane", () => {
  it("add + search + list round-trip on fakes", async () => {
    const plane = createMemory({
      grantStore: createInMemoryGrantStore([
        grant("add"),
        grant("search"),
      ]),
      conditionRegistry: {},
      documentStore: createFakeDocumentStore(),
    });
    const { documentId } = await plane.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      content: { title: "doc", text: "document body about widgets" },
    });
    const found = await plane.search({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "widgets",
      includeEvidence: true,
    });
    expect(found.items.some((i) => i.documentId === documentId)).toBe(true);
    const listed = await plane.list({
      tenantId: TENANT,
      principalId: PRINCIPAL,
    });
    expect(listed.some((e) => e.title === "doc")).toBe(true);
    await plane.close();
  });

  it("search does not invent hits for other principals without grants", async () => {
    const plane = createMemory({
      documentStore: createFakeDocumentStore(),
    });
    await plane.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      content: { title: "secret", text: "private note" },
    });
    const other = await plane.search({
      tenantId: TENANT,
      principalId: "someone-else",
      query: "private",
    });
    expect(other.items).toHaveLength(0);
    await plane.close();
  });
});
