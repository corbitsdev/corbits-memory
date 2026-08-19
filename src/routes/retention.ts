/**
 * Retention HTTP routes (CL-6288): forget (tombstone), purge (hard delete),
 * and set-retention-class. See docs/RETENTION.md.
 *
 * Tombstone and hard delete are deliberately separate routes with separate
 * grant actions (`forget` vs `purge`) — never one route with a boolean flag
 * a client could flip by accident. `purge` is the one that actually removes
 * data; its path and grant name say so.
 *
 * `sweepEphemeral` has no route here — it is a maintenance sweep a host
 * schedules on its own cron, not a user action (see docs/RETENTION.md).
 */
import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import {
  DocumentIdParam,
  ForgetRequest,
  SetRetentionClassRequest,
  VersionIdParam,
} from "../http-bodies.ts";
import { MemoryError } from "../memory.ts";
import type { RouteDeps } from "./deps.ts";
import {
  caller,
  grantGuard,
  requirePrincipal,
  resolveCaller,
} from "./deps.ts";

function respondRetentionError(err: unknown, action: string) {
  const errMessage = formatCaughtError(err);
  log.error(`memory ${action} failed: ${errMessage}`, { error: errMessage });
  if (err instanceof MemoryError) {
    return { body: { error: err.message }, status: err.status as 403 | 404 | 501 };
  }
  return { body: { error: `${action} failed` }, status: 502 as const };
}

const ForgetResponse = type({
  documentId: "string",
  versions: "number",
});

const PurgeResponse = type({
  documentId: "string",
  deleted: "boolean",
  "reason?": "string",
});

const RetentionClassResponse = type({
  versionId: "string",
  documentId: "string",
  status: "string",
});

export function mountForgetRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.post(
    "/api/tenants/:tenantId/memory/documents/:documentId/forget",

    describeRoute({
      tags: ["memory"],
      summary: "Tombstone a document — stops appearing in search, chunk text is redacted (not archived), version rows stay for audit",
      responses: {
        200: {
          description: "Tombstoned",
          content: { "application/json": { schema: resolver(ForgetResponse) } },
        },
        401: { description: "No principal on the request context" },
        403: {
          description:
            "Missing the memory:forget grant, or caller is not the document's creator",
        },
        404: { description: "Document not found" },
        502: { description: "forget failed" },
      },
    }),
    resolveCaller(deps),
    requirePrincipal(),
    grantGuard(deps, "forget"),
    validator("param", DocumentIdParam),
    validator("json", ForgetRequest),
    async (c) => {
      const { documentId } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const { scopeId, subjectId } = caller(c);
      if (!deps.memory.tombstoneDocument) {
        return c.json({ error: "retention APIs require the engine DocumentStore" }, 501);
      }
      try {
        const result = await deps.memory.tombstoneDocument({
          tenantId: scopeId,
          principalId: subjectId,
          documentId,
          ...(reason !== undefined ? { reason } : {}),
        });
        return c.json({ documentId, versions: result.versions });
      } catch (err) {
        const { body, status } = respondRetentionError(err, "forget");
        return c.json(body, status);
      }
    },
  );
}

export function mountPurgeRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.post(
    "/api/tenants/:tenantId/memory/documents/:documentId/purge",

    describeRoute({
      tags: ["memory"],
      summary: "Hard-delete a document — irreversible; refused while a durable version is untombstoned",
      responses: {
        200: {
          description: "Deletion result (deleted may be false with a reason)",
          content: { "application/json": { schema: resolver(PurgeResponse) } },
        },
        401: { description: "No principal on the request context" },
        403: {
          description:
            "Missing the memory:purge grant, or caller is not the document's creator",
        },
        404: { description: "Document not found" },
        502: { description: "purge failed" },
      },
    }),
    resolveCaller(deps),
    requirePrincipal(),
    grantGuard(deps, "purge"),
    validator("param", DocumentIdParam),
    async (c) => {
      const { documentId } = c.req.valid("param");
      const { scopeId, subjectId } = caller(c);
      if (!deps.memory.hardDeleteDocument) {
        return c.json({ error: "retention APIs require the engine DocumentStore" }, 501);
      }
      try {
        const result = await deps.memory.hardDeleteDocument({
          tenantId: scopeId,
          principalId: subjectId,
          documentId,
        });
        return c.json({
          documentId,
          deleted: result.deleted,
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        });
      } catch (err) {
        const { body, status } = respondRetentionError(err, "purge");
        return c.json(body, status);
      }
    },
  );
}

export function mountSetRetentionClassRoute(
  app: Hono<TenantEnv>,
  deps: RouteDeps,
): void {
  app.post(
    "/api/tenants/:tenantId/memory/versions/:versionId/retention-class",

    describeRoute({
      tags: ["memory"],
      summary: "Set a version's retention class (durable/standard/ephemeral/source_only)",
      responses: {
        200: {
          description: "Updated",
          content: {
            "application/json": { schema: resolver(RetentionClassResponse) },
          },
        },
        400: { description: "Invalid retention_class" },
        401: { description: "No principal on the request context" },
        403: {
          description:
            "Missing the memory:forget grant, or caller is not the version's creator",
        },
        404: { description: "Version not found" },
        502: { description: "retention-class update failed" },
      },
    }),
    resolveCaller(deps),
    requirePrincipal(),
    grantGuard(deps, "forget"),
    validator("param", VersionIdParam),
    validator("json", SetRetentionClassRequest),
    async (c) => {
      const { versionId } = c.req.valid("param");
      const { retention_class } = c.req.valid("json");
      const { scopeId, subjectId } = caller(c);
      if (!deps.memory.setRetentionClass) {
        return c.json({ error: "retention APIs require the engine DocumentStore" }, 501);
      }
      try {
        const result = await deps.memory.setRetentionClass({
          tenantId: scopeId,
          principalId: subjectId,
          versionId,
          retentionClass: retention_class,
        });
        if (!result) {
          return c.json({ error: "version not found" }, 404);
        }
        return c.json(result);
      } catch (err) {
        const { body, status } = respondRetentionError(err, "retention-class");
        return c.json(body, status);
      }
    },
  );
}
