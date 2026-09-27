import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";

import type { Memory } from "../src/memory.js";
import {
  allow,
  createTestDb,
  createTestMemory,
  seedPrincipal,
  testDatabaseUrl,
  type TestDb,
} from "./helpers.js";

const alice = { tenantId: "acme", principalId: "alice" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

describe.skipIf(testDatabaseUrl() === undefined)("feed", () => {
  let db: TestDb;
  let memory: Memory;

  beforeAll(async () => {
    db = await createTestDb();
    await seedPrincipal(db, "acme", "alice");
    memory = createTestMemory(
      db,
      createInMemoryGrantStore([
        allow("alice", "add"),
        allow("alice", "search"),
      ]),
    );
  });

  afterAll(async () => {
    await memory?.close();
    await db?.close();
  });

  // A capture that took a lower feed_seq but commits after a later one must
  // not fall behind a cursor that already moved past it.
  test("a version that commits out of feed_seq order is not skipped", async () => {
    const { documentId } = await memory.add({
      ...alice,
      externalRef: "slow",
      content: { title: "Slow", text: "first draft" },
    });
    const start = await memory.feed!({ ...alice });

    // Holding the document row stalls the next capture of it after it has
    // inserted its version.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = db.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM memory.document WHERE id = ${documentId} FOR UPDATE`;
      await held;
    });
    await settle();
    const slow = memory.add({
      ...alice,
      externalRef: "slow",
      content: { title: "Slow", text: "second draft" },
    });
    await settle();
    const fast = memory.add({
      ...alice,
      externalRef: "fast",
      content: { title: "Fast", text: "quick note" },
    });
    await settle();

    const seen = await memory.feed!({ ...alice, after: start.nextCursor ?? 0 });
    release();
    await blocker;
    const [slowResult] = await Promise.all([slow, fast]);
    const rest = await memory.feed!({
      ...alice,
      after: seen.nextCursor ?? start.nextCursor ?? 0,
    });

    const versionIds = [...seen.entries, ...rest.entries].map(
      (e) => e.versionId,
    );
    expect(versionIds).toContain(slowResult.versionId);
  }, 30_000);
});
