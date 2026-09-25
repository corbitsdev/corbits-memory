import { describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import type { Context } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import {
  caller,
  grantGuard,
  requirePrincipal,
  resolveCaller,
  type ResolvedCaller,
  type RouteDeps,
} from "./deps.js";

function grant(principalId: string, action: string): GrantRule {
  return {
    id: `g-${action}`,
    resource: "memory",
    action,
    effect: "allow",
    origin: "role",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId,
  };
}

const noopRequireGrant: RequireGrant = () => (async () => {}) as never;

// Minimal RouteDeps for unit tests — routes here only touch requireGrant.
function deps(requireGrant = noopRequireGrant): RouteDeps {
  return {
    memory: {} as RouteDeps["memory"],
    requireGrant,
  };
}

function ctxWithPrincipal(
  principal: { id: string; tenantId: string } | undefined,
): Context<TenantEnv> {
  return {
    get: (k: string) => (k === "principal" ? principal : undefined),
  } as unknown as Context<TenantEnv>;
}

describe("caller", () => {
  test("returns scope/subject from the context principal", () => {
    const c = ctxWithPrincipal({ id: "p1", tenantId: "t1" });
    expect(caller(c)).toEqual({ scopeId: "t1", subjectId: "p1" });
  });

  test("throws a legible error when no principal is on the context", () => {
    const c = ctxWithPrincipal(undefined);
    expect(() => caller(c)).toThrow(/no principal/);
  });
});

describe("requirePrincipal", () => {
  function ctxFor(principal: unknown): {
    ctx: Context<TenantEnv>;
    jsonCalls: { body: unknown; status: number }[];
  } {
    const jsonCalls: { body: unknown; status: number }[] = [];
    const ctx = {
      get: (k: string) => (k === "principal" ? principal : undefined),
      json: (body: unknown, status: number) => {
        jsonCalls.push({ body, status });
        return { body, status };
      },
    } as unknown as Context<TenantEnv>;
    return { ctx, jsonCalls };
  }

  test("responds 401 when no principal is on the context", async () => {
    const { ctx, jsonCalls } = ctxFor(undefined);
    let nextCalled = false;
    await requirePrincipal()(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(jsonCalls).toHaveLength(1);
    expect(jsonCalls[0]?.status).toBe(401);
    expect(jsonCalls[0]?.body).toMatchObject({
      error: { code: "principal_required" },
    });
  });

  test("calls next() when a principal is present", async () => {
    const { ctx, jsonCalls } = ctxFor({ id: "p1", tenantId: "t1" });
    let nextCalled = false;
    await requirePrincipal()(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(jsonCalls).toHaveLength(0);
  });
});

describe("grantGuard", () => {
  test("delegates to the host requireGrant('memory', action)", () => {
    let called: { resource: string; action: string } | undefined;
    const requireGrant: RequireGrant = (resource, action) => {
      called = { resource: String(resource), action };
      return (async () => {}) as never;
    };
grantGuard(deps(requireGrant), "add");
    expect(called).toEqual({ resource: "memory", action: "add" });
  });
});

describe("resolveCaller", () => {
  function fakeContext(): {
    ctx: Context<TenantEnv>;
    sets: Record<string, unknown>;
    jsonCalls: { body: unknown; status: number }[];
  } {
    const sets: Record<string, unknown> = {};
    const jsonCalls: { body: unknown; status: number }[] = [];
    const ctx = {
      get: (k: string) => sets[k],
      set: (k: string, v: unknown) => {
        sets[k] = v;
      },
      json: (body: unknown, status: number) => {
        jsonCalls.push({ body, status });
        return { body, status };
      },
    } as unknown as Context<TenantEnv>;
    return { ctx, sets, jsonCalls };
  }

  test("is a no-op passthrough when no callerResolver is configured", async () => {
    const { ctx, sets, jsonCalls } = fakeContext();
    let nextCalled = false;
    await resolveCaller(deps())(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(jsonCalls).toHaveLength(0);
    expect(sets.principal).toBeUndefined();
    expect(sets.tenant).toBeUndefined();
  });

  test("seats the resolved tenant/principal on the context and calls next()", async () => {
    const { ctx, sets, jsonCalls } = fakeContext();
    const resolved: ResolvedCaller = {
      tenantId: "tenant-run",
      principalId: "run-principal",
    };
    const routeDeps: RouteDeps = {
      ...deps(),
      callerResolver: () => resolved,
    };
    let nextCalled = false;
    await resolveCaller(routeDeps)(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(jsonCalls).toHaveLength(0);
    expect(sets.principal).toMatchObject({
      id: "run-principal",
      tenantId: "tenant-run",
    });
    expect(sets.tenant).toMatchObject({ id: "tenant-run" });
    expect(caller(ctx)).toEqual({
      scopeId: "tenant-run",
      subjectId: "run-principal",
    });
  });

  test("responds 401 and never calls next() when the resolver rejects the request", async () => {
    const { ctx, sets, jsonCalls } = fakeContext();
    const routeDeps: RouteDeps = {
      ...deps(),
      callerResolver: () => null,
    };
    let nextCalled = false;
    await resolveCaller(routeDeps)(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(jsonCalls).toHaveLength(1);
    expect(jsonCalls[0]?.status).toBe(401);
    expect(jsonCalls[0]?.body).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect(sets.principal).toBeUndefined();
  });

  test("supports an async callerResolver", async () => {
    const { ctx, sets } = fakeContext();
    const routeDeps: RouteDeps = {
      ...deps(),
      callerResolver: async () => ({
        tenantId: "tenant-async",
        principalId: "principal-async",
      }),
    };
    await resolveCaller(routeDeps)(ctx, async () => {});
    expect(sets.principal).toMatchObject({ id: "principal-async" });
  });

  test.each([
    ["empty-string", { tenantId: "", principalId: "" }],
    // "string >= 1" is a LENGTH constraint -- " " has length 1 and would
    // pass it. This is the same class of bug PR #34 fixed in optionalEnv
    // (v.length > 0 accepted "   "); the whitespace row is the regression
    // guard for it at this boundary.
    ["whitespace-only", { tenantId: " ", principalId: "\t\n" }],
    // Cast past the type system the way a buggy host's JS resolver would.
    ["missing-principalId", { tenantId: "tenant-run" } as unknown as ResolvedCaller],
    ["non-object", "tenant-run" as unknown as ResolvedCaller],
  ] as const)(
    "rejects a %s resolved caller with 500, never seating it",
    async (_label, resolved) => {
      const { ctx, sets, jsonCalls } = fakeContext();
      const routeDeps: RouteDeps = {
        ...deps(),
        callerResolver: () => resolved as ResolvedCaller,
      };
      let nextCalled = false;
      await resolveCaller(routeDeps)(ctx, async () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(false);
      expect(jsonCalls).toHaveLength(1);
      expect(jsonCalls[0]?.status).toBe(500);
      expect(jsonCalls[0]?.body).toMatchObject({
        error: { code: "invalid_resolved_caller" },
      });
      expect(sets.principal).toBeUndefined();
      expect(sets.tenant).toBeUndefined();
    },
  );
});
