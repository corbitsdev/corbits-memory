import { describe, expect, it } from "bun:test";

import { mapUser } from "./map-user.ts";

describe("mapUser", () => {
  it("joins tenantId::principalId", () => {
    expect(mapUser("tenant-a", "user-1")).toBe("tenant-a::user-1");
  });

  it("isolates same principal across tenants", () => {
    const a = mapUser("tenant-a", "alice");
    const b = mapUser("tenant-b", "alice");
    expect(a).toBe("tenant-a::alice");
    expect(b).toBe("tenant-b::alice");
    expect(a).not.toBe(b);
  });

  it("rejects empty tenantId", () => {
    expect(() => mapUser("", "alice")).toThrow(/tenantId/);
    expect(() => mapUser("   ", "alice")).toThrow(/tenantId/);
  });

  it("rejects empty principalId", () => {
    expect(() => mapUser("tenant-a", "")).toThrow(/principalId/);
    expect(() => mapUser("tenant-a", "  ")).toThrow(/principalId/);
  });
});
