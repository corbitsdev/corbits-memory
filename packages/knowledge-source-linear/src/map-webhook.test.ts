import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mapIssueCreated,
  mapIssueRemoved,
  mapIssueUpdated,
  mapLinearWebhook,
} from "./map-webhook.ts";
import type { AdaptedDocument, LinearWebhookEvent } from "./types.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

function loadFixture(name: string): LinearWebhookEvent {
  const raw = readFileSync(join(FIXTURES, name), "utf8");
  return JSON.parse(raw) as LinearWebhookEvent;
}

function assertAdapterActor(doc: AdaptedDocument) {
  expect(doc.actor.kind).toBe("adapter");
  expect(doc.actor.principalId).toBeUndefined();
}

function assertNeverSourceAcl(doc: AdaptedDocument) {
  expect((doc.visibility as { mode: string }).mode).not.toBe("source_acl");
}

describe("fixture → AdaptedDocument goldens", () => {
  it("mapIssueCreated: team-visible issue → tenant visibility, adapter actor", () => {
    const event = loadFixture("issue-created.json");
    const doc = mapIssueCreated(event);

    expect(doc.kind).toBe("issue");
    expect(doc.title).toBe("Wire Linear SourceProvider");
    expect(doc.externalRef).toBe("CL-100");
    expect(doc.visibility).toEqual({ mode: "tenant" });
    assertNeverSourceAcl(doc);
    assertAdapterActor(doc);
    expect(doc.chunks).toHaveLength(1);
    expect(doc.chunks[0]?.ordinal).toBe(0);
    expect(doc.chunks[0]?.text).toContain("Wire Linear SourceProvider");
    expect(doc.chunks[0]?.text).toContain("Thin mapper package");
    expect(doc.attributes?.linear_id).toBe("issue-uuid-100");
    expect(doc.attributes?.identifier).toBe("CL-100");
    expect(doc.attributes?.removed).toBeUndefined();
    expect(doc.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(doc.entityHints.length).toBeGreaterThanOrEqual(1);
  });

  it("mapIssueUpdated: reflects new title/description and new contentHash", () => {
    const created = mapIssueCreated(loadFixture("issue-created.json"));
    const updated = mapIssueUpdated(loadFixture("issue-updated.json"));

    expect(updated.title).toBe("Wire Linear SourceProvider (done)");
    expect(updated.externalRef).toBe("CL-100");
    expect(updated.visibility).toEqual({ mode: "tenant" });
    assertAdapterActor(updated);
    expect(updated.attributes?.state_name).toBe("Done");
    expect(updated.chunks[0]?.text).toContain("Shipped");
    expect(updated.contentHash).not.toBe(created.contentHash);
  });

  it("mapIssueRemoved: empty chunks, removed attribute, same externalRef", () => {
    const doc = mapIssueRemoved(loadFixture("issue-removed.json"));

    expect(doc.externalRef).toBe("CL-100");
    expect(doc.title).toBe("Wire Linear SourceProvider (done)");
    expect(doc.chunks).toEqual([]);
    expect(doc.attributes?.removed).toBe(true);
    expect(doc.visibility).toEqual({ mode: "tenant" });
    assertAdapterActor(doc);
    expect(doc.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("overshare guard: private multi-principal issue never maps to tenant", () => {
    const doc = mapIssueCreated(loadFixture("private-issue-created.json"));

    expect(doc.visibility.mode).not.toBe("tenant");
    expect(doc.visibility.mode).toBe("principals");
    expect(doc.visibility.principalIds).toEqual(
      expect.arrayContaining(["user-alice", "user-dave"]),
    );
    expect(doc.visibility.principalIds).toHaveLength(2);
    assertNeverSourceAcl(doc);
    assertAdapterActor(doc);
    expect(doc.externalRef).toBe("CL-PRIV-1");
  });

  it("overshare guard: private solo issue → private mode, never tenant", () => {
    const doc = mapIssueCreated(loadFixture("private-issue-solo.json"));

    expect(doc.visibility.mode).toBe("private");
    expect(doc.visibility.mode).not.toBe("tenant");
    expect(doc.visibility.principalIds).toEqual(["user-alice"]);
    assertAdapterActor(doc);
  });

  it("private via team.private alone (no issue.private) still not tenant", () => {
    const event = loadFixture("private-issue-created.json");
    // Simulate team-private without top-level private flag
    const data = {
      ...event.data,
      private: false,
      team: { ...event.data.team, private: true },
    };
    const doc = mapIssueCreated({ ...event, data });
    expect(doc.visibility.mode).not.toBe("tenant");
    expect(["private", "principals"]).toContain(doc.visibility.mode);
  });
});

describe("mapLinearWebhook dispatcher", () => {
  it("dispatches create/update/remove", () => {
    const c = mapLinearWebhook(loadFixture("issue-created.json"));
    expect(c?.action).toBe("create");
    expect(c?.document.externalRef).toBe("CL-100");

    const u = mapLinearWebhook(loadFixture("issue-updated.json"));
    expect(u?.action).toBe("update");
    expect(u?.document.title).toContain("done");

    const r = mapLinearWebhook(loadFixture("issue-removed.json"));
    expect(r?.action).toBe("remove");
    expect(r?.document.attributes?.removed).toBe(true);
  });

  it("returns null for non-Issue types", () => {
    const event = loadFixture("issue-created.json");
    expect(mapLinearWebhook({ ...event, type: "Comment" })).toBeNull();
  });

  it("returns null for unknown actions", () => {
    const event = loadFixture("issue-created.json");
    expect(mapLinearWebhook({ ...event, action: "restore" })).toBeNull();
  });
});

describe("deterministic goldens (stable contentHash)", () => {
  it("same fixture maps to identical contentHash twice", () => {
    const a = mapIssueCreated(loadFixture("issue-created.json"));
    const b = mapIssueCreated(loadFixture("issue-created.json"));
    expect(a.contentHash).toBe(b.contentHash);
    expect(a).toEqual(b);
  });
});
