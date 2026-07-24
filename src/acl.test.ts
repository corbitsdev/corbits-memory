import { describe, expect, test } from "bun:test";

import { parseAcl } from "./acl.ts";

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
