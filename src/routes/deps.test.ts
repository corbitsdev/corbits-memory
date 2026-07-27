import { describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import type { Context } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import { caller, grantGuard, type RouteDeps } from "./deps.ts";

function grant(principalId: string, action: string): GrantRule {
  return {
    id: `g-${action}`,
    resource: "knowledge",
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

// Minimal RouteDeps for unit tests — routes here only touch grants/requireGrant.
function deps(grants: RouteDeps["grants"], requireGrant = noopRequireGrant): RouteDeps {
  return {
    knowledge: {} as RouteDeps["knowledge"],
    grants,
    requireGrant,
  };
}

function grantsWith(...rules: GrantRule[]): RouteDeps["grants"] {
  return {
    grantStore: createInMemoryGrantStore(rules),
    conditionRegistry: {},
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

describe("grantGuard", () => {
  test("delegates to the host requireGrant('knowledge', action)", () => {
    let called: { resource: string; action: string } | undefined;
    const requireGrant: RequireGrant = (resource, action) => {
      called = { resource: String(resource), action };
      return (async () => {}) as never;
    };
    grantGuard(deps(grantsWith(), requireGrant), "capture");
    expect(called).toEqual({ resource: "knowledge", action: "capture" });
  });
});
