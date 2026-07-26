import { describe, expect, test } from "bun:test";

import { blockedDocumentIds, parseAcl, readBlockList } from "./acl.ts";

describe("parseAcl", () => {
  test("default is scope/tenant", () => {
    const r = parseAcl(undefined, "u1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.visibility).toEqual({ mode: "tenant" });
  });

  test("private pins subject", () => {
    const r = parseAcl({ mode: "private" }, "u1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.visibility).toEqual({ mode: "private", principalIds: ["u1"] });
    }
  });

  test("allowlist always includes subject", () => {
    const r = parseAcl({ mode: "allowlist", allow: ["other"] }, "u1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.visibility.mode).toBe("principals");
      expect(r.visibility.principalIds).toContain("u1");
      expect(r.visibility.principalIds).toContain("other");
    }
  });

  test("nested { subjects } allow/block shape", () => {
    const r = parseAcl(
      {
        mode: "allowlist",
        allow: { subjects: ["alice"] },
        block: { subjects: ["bob"] },
      },
      "u1",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.visibility.mode).toBe("principals");
      expect(r.visibility.principalIds).toEqual(
        expect.arrayContaining(["u1", "alice"]),
      );
      expect(r.block).toEqual(["bob"]);
    }
  });

  test("rejects groups/grants until membership lands", () => {
    const r = parseAcl(
      { mode: "allowlist", allow: { subjects: ["a"], groups: ["eng"] } },
      "u1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/groups/);
  });
});

describe("readBlockList", () => {
  test("reads the JSON-string encoding capture() writes", () => {
    expect(readBlockList(JSON.stringify(["p1", "p2"]))).toEqual({
      kind: "list",
      principalIds: ["p1", "p2"],
    });
  });

  test("reads a native array, which is what jsonb holds naturally", () => {
    // A seed script, migration or other service writing the column directly
    // has no reason to double-encode. Whether a block list is honoured must
    // not depend on which writer produced it.
    expect(readBlockList(["p1"])).toEqual({
      kind: "list",
      principalIds: ["p1"],
    });
  });

  test("absent, null and empty are absent, not blocked", () => {
    expect(readBlockList(undefined)).toEqual({ kind: "absent" });
    expect(readBlockList(null)).toEqual({ kind: "absent" });
    expect(readBlockList("")).toEqual({ kind: "absent" });
  });

  test("an empty list blocks nobody but is still a list", () => {
    expect(readBlockList([])).toEqual({ kind: "list", principalIds: [] });
    expect(readBlockList("[]")).toEqual({ kind: "list", principalIds: [] });
  });

  test("unparseable string is unreadable", () => {
    expect(readBlockList("{not json")).toEqual({ kind: "unreadable" });
  });

  test("a present value that is not a list of ids is unreadable", () => {
    // The regression this exists for: these once skipped the block check
    // entirely, so a document with an ACL nobody could read was returned.
    const notLists: unknown[] = [
      42,
      true,
      false,
      0,
      { subjects: ["p1"] },
      '"p1"',
      "null",
      "   x",
      ["p1", 7],
      ["p1", null],
      [["p1"]],
      [{}],
    ];
    for (const raw of notLists) {
      expect({ raw, read: readBlockList(raw) }).toEqual({
        raw,
        read: { kind: "unreadable" },
      });
    }
  });
});

describe("blockedDocumentIds", () => {
  const row = (id: string, aclBlock?: unknown) => ({
    id,
    attributes: aclBlock === undefined ? {} : { acl_block: aclBlock },
  });

  test("blocks a principal named in the list", () => {
    const { blocked } = blockedDocumentIds(["d1"], [row("d1", ["p1"])], "p1");
    expect([...blocked]).toEqual(["d1"]);
  });

  test("leaves a document alone when the principal is not named", () => {
    const { blocked } = blockedDocumentIds(["d1"], [row("d1", ["p2"])], "p1");
    expect([...blocked]).toEqual([]);
  });

  test("withholds a document whose acl_block cannot be read", () => {
    // The consequence the fix exists for: an unreadable ACL must remove the
    // document, not merely be classified as unreadable.
    const { blocked, unreadable } = blockedDocumentIds(
      ["d1"],
      [row("d1", 42)],
      "p1",
    );
    expect([...blocked]).toEqual(["d1"]);
    expect(unreadable).toEqual(["d1"]);
  });

  test("withholds a searched document whose row did not come back", () => {
    // Deleted between the search and the post-filter. We cannot evaluate its
    // ACL, so it must not be returned.
    const { blocked, unreadable } = blockedDocumentIds(["d1", "d2"], [row("d1")], "p1");
    expect([...blocked]).toEqual(["d2"]);
    expect(unreadable).toEqual(["d2"]);
  });

  test("does not withhold documents with no acl_block at all", () => {
    const { blocked, unreadable } = blockedDocumentIds(
      ["d1", "d2"],
      [row("d1"), row("d2", null)],
      "p1",
    );
    expect([...blocked]).toEqual([]);
    expect(unreadable).toEqual([]);
  });

  test("honours a block written as a native array, not only a JSON string", () => {
    const viaString = blockedDocumentIds(
      ["d1"],
      [row("d1", JSON.stringify(["p1"]))],
      "p1",
    );
    const viaArray = blockedDocumentIds(["d1"], [row("d1", ["p1"])], "p1");
    expect([...viaString.blocked]).toEqual([...viaArray.blocked]);
  });
});
