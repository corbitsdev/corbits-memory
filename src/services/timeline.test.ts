import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { desc } from "drizzle-orm";

import { LIVE_GENERATION } from "../core/generation.ts";
import { knowledgeDocument } from "../db/schema.ts";
import {
  filterTimelineRowsForPrincipal,
  timelineActiveVersionJoin,
  timelineWhere,
  type TimelineRow,
} from "./timeline.ts";

const dialect = new PgDialect();

function row(
  overrides: Partial<TimelineRow> & { id: string; title: string },
): TimelineRow {
  return {
    tenantId: "t1",
    adapter: "mcp",
    lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    attributes: {},
    principalId: "alice",
    ...overrides,
  };
}

describe("filterTimelineRowsForPrincipal", () => {
  it("keeps tenant-visible events and drops blocked titles for the caller", () => {
    const rows: TimelineRow[] = [
      row({ id: "1", title: "team standup notes" }),
      row({
        id: "2",
        title: "Q3 layoffs — draft list",
        attributes: { acl_block: JSON.stringify(["p1"]) },
      }),
      row({
        id: "3",
        title: "ok for everyone",
        attributes: { acl_block: JSON.stringify(["other"]) },
      }),
    ];
    const { events, failClosedCount } = filterTimelineRowsForPrincipal(
      rows,
      "p1",
      100,
    );
    expect(failClosedCount).toBe(0);
    expect(events.map((e) => e.title)).toEqual([
      "team standup notes",
      "ok for everyone",
    ]);
    expect(events.map((e) => e.title)).not.toContain("Q3 layoffs — draft list");
  });

  it("fail-closes on unparseable acl_block and does not surface the title", () => {
    const rows: TimelineRow[] = [
      row({
        id: "bad",
        title: "should not leak",
        attributes: { acl_block: "{not-json" },
      }),
      row({ id: "ok", title: "visible" }),
    ];
    const { events, failClosedCount } = filterTimelineRowsForPrincipal(
      rows,
      "p1",
      100,
    );
    expect(failClosedCount).toBe(1);
    expect(events.map((e) => e.title)).toEqual(["visible"]);
  });

  it("maps wire fields from durable row columns (lastSeenAt → at, adapter → source)", () => {
    const rows: TimelineRow[] = [
      row({
        id: "1",
        title: "note",
        adapter: "mcp",
        principalId: "alice",
        lastSeenAt: new Date("2026-06-01T12:00:00.000Z"),
      }),
    ];
    const { events } = filterTimelineRowsForPrincipal(rows, "p1", 100);
    expect(events[0]).toEqual({
      at: "2026-06-01T12:00:00.000Z",
      title: "note",
      source: "mcp",
      tenantId: "t1",
      principalId: "alice",
    });
  });

  it("respects the limit after filtering", () => {
    const rows: TimelineRow[] = [
      row({
        id: "blocked",
        title: "blocked",
        attributes: { acl_block: JSON.stringify(["p1"]) },
      }),
      row({ id: "a", title: "a" }),
      row({ id: "b", title: "b" }),
    ];
    const { events } = filterTimelineRowsForPrincipal(rows, "p1", 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("a");
  });

  it("uses empty string when version principal is null", () => {
    const rows: TimelineRow[] = [
      row({ id: "1", title: "sys", principalId: null }),
    ];
    const { events } = filterTimelineRowsForPrincipal(rows, "p1", 100);
    expect(events[0]?.principalId).toBe("");
  });
});

describe("listTimelineEvents SQL composition (shared with search)", () => {
  it("timelineWhere attaches tenant + the same visibilityPredicateSql as search", () => {
    const fragment = timelineWhere("t1", "principal_a");
    const { sql, params } = dialect.sqlToQuery(fragment!);
    expect(sql).toContain("tenant_id");
    expect(sql).toContain("visibility_mode");
    expect(sql).toContain("'tenant'");
    expect(sql).toContain("'principals', 'private'");
    expect(sql).toContain("visibility_principal_ids");
    expect(params).toContain("t1");
    expect(params).toContain(JSON.stringify(["principal_a"]));
  });

  it("timelineWhere with a principal never matches private/allowlist docs for others", () => {
    // Regression: private/principals visibility requires principal_ids @> [caller].
    // A second principal must not satisfy that containment for the first's private doc.
    const forAlice = dialect.sqlToQuery(timelineWhere("t1", "alice")!);
    const forBob = dialect.sqlToQuery(timelineWhere("t1", "bob")!);
    expect(forAlice.params).toContain(JSON.stringify(["alice"]));
    expect(forBob.params).toContain(JSON.stringify(["bob"]));
    expect(forAlice.params).not.toContain(JSON.stringify(["bob"]));
    // Both include the principals/private branch (not tenant-only null-principal shape).
    expect(forAlice.sql).toContain("'principals', 'private'");
    expect(forBob.sql).toContain("'principals', 'private'");
  });

  it("timelineActiveVersionJoin pins active + live generation", () => {
    const fragment = timelineActiveVersionJoin();
    const { sql, params } = dialect.sqlToQuery(fragment!);
    expect(sql).toContain("document_id");
    expect(sql).toContain("status");
    expect(sql).toContain("generation");
    expect(params).toContain("active");
    expect(params).toContain(LIVE_GENERATION);
  });

  it("orders by last_seen_at so re-captures rise in the timeline", () => {
    const { sql } = dialect.sqlToQuery(desc(knowledgeDocument.lastSeenAt));
    expect(sql).toContain("last_seen_at");
  });
});
