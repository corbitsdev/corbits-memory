import { describe, expect, it } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  filterTimelineRows,
  timelineWhere,
  type TimelineRow,
} from "./timeline.ts";

const dialect = new PgDialect();

function row(overrides: Partial<TimelineRow> = {}): TimelineRow {
  return {
    documentId: "doc_1",
    title: "Title",
    adapter: "http",
    externalRef: "note:1",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    createdByPrincipalId: "owner",
    accessTags: ["memory.owner:owner"],
    ...overrides,
  };
}

describe("filterTimelineRows (grant-tag access)", () => {
  it("allows the creator without grants on tags", async () => {
    const { events, withheld } = await filterTimelineRows(
      [row({ createdByPrincipalId: "p1", accessTags: [] })],
      { principalId: "p1", tenantId: "t1", grants: createInMemoryGrantStore([]) },
    );
    expect(withheld).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("Title");
  });

  it("denies a peer without a matching grant", async () => {
    const { events, withheld } = await filterTimelineRows(
      [row({ createdByPrincipalId: "owner", accessTags: ["memory.tenant:t1"] })],
      {
        principalId: "peer",
        tenantId: "t1",
        grants: createInMemoryGrantStore([]),
      },
    );
    expect(withheld).toBe(1);
    expect(events).toHaveLength(0);
  });

  it("allows a peer with a grant on an access tag", async () => {
    const grants = createInMemoryGrantStore([
      {
        id: "g1",
        principalId: "peer",
        resource: "memory.tenant:t1",
        action: "search",
        effect: "allow",
        origin: "role",
        conditions: null,
        expiresAt: null,
        roleId: null,
      },
    ]);
    const { events, withheld } = await filterTimelineRows(
      [
        row({
          createdByPrincipalId: "owner",
          accessTags: ["memory.tenant:t1"],
        }),
      ],
      { principalId: "peer", tenantId: "t1", grants },
    );
    expect(withheld).toBe(0);
    expect(events).toHaveLength(1);
  });

  it("creator-only when no GrantStore is mounted", async () => {
    const { events, withheld } = await filterTimelineRows(
      [
        row({ documentId: "a", createdByPrincipalId: "p1", title: "mine" }),
        row({ documentId: "b", createdByPrincipalId: "other", title: "theirs" }),
      ],
      { principalId: "p1", tenantId: "t1" },
    );
    expect(withheld).toBe(1);
    expect(events.map((e) => e.title)).toEqual(["mine"]);
  });
});

describe("timelineWhere", () => {
  it("is tenant-only (no visibility mini-ACL in SQL)", () => {
    const { sql, params } = dialect.sqlToQuery(timelineWhere("tenant_a"));
    expect(sql).toContain("tenant_id");
    expect(params).toContain("tenant_a");
    expect(sql).not.toContain("visibility_mode");
    expect(sql).not.toContain("visibility_principal_ids");
  });
});
