import { describe, expect, it } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";

import { ownerTag, tenantTag } from "../acl.ts";
import {
  createFakeDocumentStore,
  createFakeSourceProvider,
} from "./fakes.ts";

const TENANT = "t1";
const PRINCIPAL = "p1";
const OTHER = "p2";

describe("createFakeDocumentStore", () => {
  it("round-trips add → find → recent", async () => {
    const store = createFakeDocumentStore();
    const { documentId } = await store.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      title: "standup notes",
      text: "shipped the ports foundation",
      accessTags: [ownerTag(PRINCIPAL), tenantTag(TENANT)],
    });
    expect(documentId).toMatch(/^fake_doc_/);

    const found = await store.find({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "ports foundation",
      includeEvidence: true,
    });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.documentId).toBe(documentId);
    expect(found.evidence).toBe("weak");

    const events = await store.recent({
      tenantId: TENANT,
      principalId: PRINCIPAL,
    });
    expect(events.map((e) => e.title)).toEqual(["standup notes"]);
    await store.close();
  });

  it("creator-only without grants; other principal cannot see", async () => {
    const store = createFakeDocumentStore();
    await store.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      title: "secret",
      text: "classified payload",
      accessTags: [ownerTag(PRINCIPAL)],
    });
    const asOwner = await store.find({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      query: "classified",
    });
    const asOther = await store.find({
      tenantId: TENANT,
      principalId: OTHER,
      query: "classified",
    });
    expect(asOwner.items).toHaveLength(1);
    expect(asOther.items).toHaveLength(0);
    await store.close();
  });

  it("peer with grant on owner tag can see", async () => {
    const store = createFakeDocumentStore();
    await store.add({
      tenantId: TENANT,
      principalId: PRINCIPAL,
      title: "shared note",
      text: "visible body",
      accessTags: [ownerTag(PRINCIPAL), ownerTag(OTHER)],
    });
    const grants = createInMemoryGrantStore([
      {
        id: "g1",
        principalId: OTHER,
        resource: ownerTag(OTHER),
        action: "find",
        effect: "allow",
        origin: "role",
        conditions: null,
        expiresAt: null,
        roleId: null,
      },
    ]);
    const asOther = await store.find({
      tenantId: TENANT,
      principalId: OTHER,
      query: "visible",
      grants,
    });
    expect(asOther.items).toHaveLength(1);
    await store.close();
  });
});

describe("createFakeSourceProvider", () => {
  it("searchLive filters catalog by query", async () => {
    const source = createFakeSourceProvider("linear", [
      {
        adapter: "linear",
        externalRef: "CL-1",
        title: "ports foundation",
        snippet: "DocumentStore + SourceProvider",
        score: 0.9,
        kind: "issue",
        citation: {
          adapter: "linear",
          external_ref: "CL-1",
          open: {
            type: "issue",
            id: "CL-1",
            url: "https://linear.app/x/issue/CL-1",
          },
        },
      },
      {
        adapter: "linear",
        externalRef: "CL-2",
        title: "unrelated",
        snippet: "something else",
        score: 0.1,
        kind: "issue",
        citation: {
          adapter: "linear",
          external_ref: "CL-2",
          open: {
            type: "issue",
            id: "CL-2",
            url: "https://linear.app/x/issue/CL-2",
          },
        },
      },
    ]);
    const hits = await source.searchLive!({
      query: "ports",
      tenantId: TENANT,
      principalId: PRINCIPAL,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.externalRef).toBe("CL-1");
  });
});
