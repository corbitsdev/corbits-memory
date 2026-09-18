/**
 * Run-scoped variant of the memory routes for a host whose callers are
 * deployed agents rather than browser sessions: there is no `TenantEnv`
 * principal on the context, only a hub-minted bearer plus the run address it
 * is acting for. The human-facing tenant routes keep their session auth
 * untouched — mixing two unrelated auth conventions into one mount would
 * make each harder to reason about, so this is a second, parallel mount a
 * host wires up only when it actually runs agents.
 *
 * Authorization is the token itself: the hub only mints an agent token for a
 * definition it already authorized, and every call here is confined to the
 * verified run's tenant and principal. This mount runs no grant check of its
 * own and has no tenant override.
 */
import { type } from "arktype";
import type { Hono, MiddlewareHandler } from "hono";

import {
  AddRequest,
  parseFeedQuery,
  parseListLimitString,
  SearchRequest,
} from "./http-bodies.ts";
import { formatCaughtError, log } from "./log.ts";
import { MemoryError, type Memory } from "./memory.ts";
import { tenantTag, type ShareSugar } from "./grant-tags.ts";

/**
 * The tags a verified run already proves: the token is minted for exactly one
 * tenant, so a run reads its workbench's shared memories without a grant row —
 * and never another tenant's, since the tag carries the verified tenant id.
 */
function teamTags(scope: ResolvedWorkflowRunScope): readonly string[] {
  return [tenantTag(scope.tenantId)];
}

/** Who a run authenticates as, and which run it is acting on behalf of. */
export type ResolvedWorkflowRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

/** What a verified agent token proves. Structural, so this package never
 * depends on the library that mints one. */
export type AgentTokenIdentity = {
  readonly tenantId: string;
  readonly definitionId: string;
};

/**
 * The host's two halves of agent authentication. `verify` reads the
 * presented `Authorization` header and returns `undefined` when it is not an
 * agent token; `resolveRun` is the host's existing lookup from the
 * `x-workflow-run-address` header to the run. A token whose tenant is not
 * the resolved run's tenant is refused, so a bearer minted for one workbench
 * cannot act on another's run.
 */
export type AgentTokenAuth = {
  verify: (
    ctx: unknown,
  ) => Promise<AgentTokenIdentity | undefined> | AgentTokenIdentity | undefined;
  resolveRun: (
    runAddress: string,
  ) => Promise<ResolvedWorkflowRunScope | null> | ResolvedWorkflowRunScope | null;
};

export type WorkflowMemoryEnv = {
  Variables: { workflowRunScope: ResolvedWorkflowRunScope };
};

export type MountWorkflowMemoryOpts = {
  memory: Memory;
  agentToken: AgentTokenAuth;
};

/**
 * Mount the run-scoped memory routes onto a host Hono app. Every route sits
 * behind the bearer middleware — there is no unauthenticated case, since an
 * agent run always presents credentials.
 */
export function mountWorkflowMemory(
  app: Hono<WorkflowMemoryEnv>,
  opts: MountWorkflowMemoryOpts,
): Hono<WorkflowMemoryEnv> {
  const { memory, agentToken } = opts;

  const authenticate: MiddlewareHandler<WorkflowMemoryEnv> = async (c, next) => {
    const identity = await agentToken.verify(c);
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = identity === undefined ? null : await agentToken.resolveRun(address);
    // Same 401 whether the bearer was unrecognized, the address named no run,
    // or the run belongs to another tenant: a bearer learns nothing from the
    // difference.
    if (identity === undefined || scope === null || scope.tenantId !== identity.tenantId) {
      return c.json(
        { error: "Missing or unrecognized bearer token / run address" },
        401,
      );
    }
    c.set("workflowRunScope", scope);
    await next();
    return undefined;
  };
  app.use("*", authenticate);

  function failure(c: Parameters<MiddlewareHandler<WorkflowMemoryEnv>>[0], verb: string, err: unknown) {
    if (err instanceof MemoryError) {
      return c.json({ error: err.message }, err.status as 400 | 501);
    }
    const message = formatCaughtError(err);
    log.error(`memory ${verb} failed: ${message}`, { error: message });
    return c.json({ error: `${verb} failed` }, 502);
  }

  app.post("/add", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const body = AddRequest(raw);
    if (body instanceof type.errors) return c.json({ error: body.summary }, 400);

    const scope = c.get("workflowRunScope");
    try {
      const result = await memory.add({
        content: { title: body.title, text: body.text },
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        ...(body.access_tags !== undefined ? { accessTags: body.access_tags } : {}),
        // A workbench is the team: a run's memories are shared with it by
        // default, and an explicit share only ever adds to that.
        share: { ...((body.share ?? {}) as ShareSugar), tenant: true },
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.generator_agent_id !== undefined
          ? { generatorAgentId: body.generator_agent_id }
          : {}),
        ...(body.provenance !== undefined ? { provenance: body.provenance } : {}),
        ...(body.lineage_class !== undefined ? { lineageClass: body.lineage_class } : {}),
        ...(body.temporal_class !== undefined ? { temporalClass: body.temporal_class } : {}),
        ...(body.derived_from !== undefined ? { derivedFrom: body.derived_from } : {}),
        ...(body.valid_from !== undefined ? { validFrom: body.valid_from } : {}),
        ...(body.valid_until !== undefined ? { validUntil: body.valid_until } : {}),
      });
      return c.json({ data: result });
    } catch (err) {
      return failure(c, "add", err);
    }
  });

  app.post("/search", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const body = SearchRequest(raw);
    if (body instanceof type.errors) return c.json({ error: body.summary }, 400);

    const scope = c.get("workflowRunScope");
    try {
      const result = await memory.search({
        query: body.query,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        visibleTags: teamTags(scope),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
        ...(body.kinds !== undefined ? { kinds: body.kinds } : {}),
        ...(body.entity_ids !== undefined ? { entityIds: body.entity_ids } : {}),
        ...(body.sources !== undefined ? { sources: body.sources } : {}),
        ...(body.includeEvidence !== undefined
          ? { includeEvidence: body.includeEvidence }
          : {}),
        ...(body.includeDeprecated !== undefined
          ? { includeDeprecated: body.includeDeprecated }
          : {}),
      });
      return c.json({ data: result });
    } catch (err) {
      return failure(c, "search", err);
    }
  });

  app.get("/list", async (c) => {
    const limit = parseListLimitString(c.req.query("limit"));
    if (limit === null) return c.json({ error: "limit is out of range" }, 400);

    const scope = c.get("workflowRunScope");
    try {
      const events = await memory.list({
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        visibleTags: teamTags(scope),
        ...(limit !== undefined ? { limit } : {}),
      });
      return c.json({ data: events });
    } catch (err) {
      return failure(c, "list", err);
    }
  });

  app.get("/feed", async (c) => {
    if (memory.feed === undefined) {
      return c.json({ error: "feed is not available on this memory plane" }, 501);
    }
    const after = c.req.query("after");
    const limit = c.req.query("limit");
    const excludeGenerator = c.req.query("exclude_generator");
    const parsed = parseFeedQuery({
      ...(after !== undefined ? { after } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(excludeGenerator !== undefined ? { exclude_generator: excludeGenerator } : {}),
    });
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const scope = c.get("workflowRunScope");
    try {
      const result = await memory.feed({
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        visibleTags: teamTags(scope),
        ...parsed.value,
      });
      return c.json({ data: result });
    } catch (err) {
      return failure(c, "feed", err);
    }
  });

  return app;
}
