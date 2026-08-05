import { describe, expect, it } from "bun:test";

import { mapUser } from "./map-user.ts";

describe("mapUser", () => {
  it("length-prefixes tenant and principal", () => {
    expect(mapUser("tenant-a", "user-1")).toBe("8:tenant-a:6:user-1");
  });

  it("isolates the same principal across tenants", () => {
    const a = mapUser("tenant-a", "alice");
    const b = mapUser("tenant-b", "alice");
    expect(a).not.toBe(b);
  });

  it("rejects empty tenantId", () => {
    expect(() => mapUser("", "alice")).toThrow(/tenantId/);
  });

  it("rejects empty principalId", () => {
    expect(() => mapUser("t", "")).toThrow(/principalId/);
  });

  it("rejects whitespace-only ids", () => {
    expect(() => mapUser("  ", "alice")).toThrow(/tenantId/);
    expect(() => mapUser("t", "  ")).toThrow(/principalId/);
  });

  it("is injective when ids contain delimiter sequences", () => {
    // Old `tenant::principal` encoding collided on these pairs.
    const a = mapUser("a::b", "c");
    const b = mapUser("a", "b::c");
    expect(a).not.toBe(b);
    expect(a).toBe("4:a::b:1:c");
    expect(b).toBe("1:a:4:b::c");
  });
});
