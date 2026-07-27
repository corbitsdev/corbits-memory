import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq } from "drizzle-orm";

import { knowledgeDocument } from "../db/schema.ts";
import { visibilityPredicateSql } from "./search.ts";
import {
  filterTimelineRowsForPrincipal,
  type TimelineRow,
} from "./timeline.ts";

const dialect = new PgDialect();

function row(overrides: Partial<TimelineRow> & { id: string; title: string }): TimelineRow {
  return {
    tenantId: "t1",
    adapter: "mcp",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
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
        title: "private note for someone else",
        // Visibility is SQL-side; a private-other row would not reach this
        // filter. Still: if it did without a block, filter would keep it —
        // this asserts only the block post-filter contract.
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
      "private note for someone else",
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

  it("maps wire fields from durable row columns", () => {
    const rows: TimelineRow[] = [
      row({
        id: "1",
        title: "note",
        adapter: "mcp",
        principalId: "alice",
        createdAt: new Date("2026-06-01T12:00:00.000Z"),
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

describe("timeline visibility SQL (shared with search)", () => {
  it("attaches the same visibilityPredicateSql principal check the search path uses", () => {
    // listTimelineEvents composes tenant + visibilityPredicateSql; assert the
    // fragment shape so a third implementation cannot silently diverge.
    const fragment = and(
      eq(knowledgeDocument.tenantId, "t1"),
      visibilityPredicateSql("principal_a"),
    );
    const { sql, params } = dialect.sqlToQuery(fragment!);
    expect(sql).toContain("tenant_id");
    expect(sql).toContain("visibility_mode");
    expect(sql).toContain("'principals', 'private'");
    expect(params).toContain("t1");
    expect(params).toContain(JSON.stringify(["principal_a"]));
  });
});
