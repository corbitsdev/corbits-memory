import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import { resolveAccessTags, type ShareSugar } from "../grant-tags.ts";
import { AddRequest } from "../http-bodies.ts";

import { MemoryError } from "../memory.ts";
import type { RouteDeps } from "./deps.ts";
import {
  caller,
  grantGuard,
  requirePrincipal,
  resolveCaller,
} from "./deps.ts";

const AddResponse = type({
  documentId: "string",
  versionId: "string",
});

export function mountAddRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.post(
    "/api/tenants/:tenantId/memory/add",

    describeRoute({
      tags: ["memory"],
      summary: "Add a note into memory",
      responses: {
        200: {
          description: "Added",
          content: {
            "application/json": { schema: resolver(AddResponse) },
          },
        },
        400: { description: "Invalid request or access tags" },
        401: { description: "No principal on the request context" },
        403: { description: "Missing the memory:add grant" },
        502: { description: "add failed" },
      },
    }),
    resolveCaller(deps),
    requirePrincipal(),
    grantGuard(deps, "add"),
    validator("json", AddRequest),
    async (c) => {
      const body = c.req.valid("json");
      const { title, text } = body;
      const { scopeId, subjectId } = caller(c);

      const accessTags = body.access_tags;
      const share = body.share as ShareSugar | undefined;

      // Validate tag resolution early (empty strings stripped, owner always present).
      if (accessTags || share) {
        resolveAccessTags({
          principalId: subjectId,
          tenantId: scopeId,
          ...(accessTags !== undefined ? { accessTags } : {}),
          ...(share !== undefined ? { share } : {}),
        });
      }

      try {
        const result = await deps.memory.add({
          content: { title, text },
          tenantId: scopeId,
          principalId: subjectId,
          ...(accessTags !== undefined ? { accessTags } : {}),
          ...(share !== undefined ? { share } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.generator_agent_id !== undefined
            ? { generatorAgentId: body.generator_agent_id }
            : {}),
          ...(body.provenance !== undefined
            ? { provenance: body.provenance }
            : {}),
          ...(body.lineage_class !== undefined
            ? { lineageClass: body.lineage_class }
            : {}),
          ...(body.temporal_class !== undefined
            ? { temporalClass: body.temporal_class }
            : {}),
          ...(body.derived_from !== undefined
            ? { derivedFrom: body.derived_from }
            : {}),
          ...(body.valid_from !== undefined
            ? { validFrom: body.valid_from }
            : {}),
          ...(body.valid_until !== undefined
            ? { validUntil: body.valid_until }
            : {}),
        });
        return c.json({ documentId: result.documentId, versionId: result.versionId });
      } catch (err) {
        if (err instanceof MemoryError) {
          return c.json(
            { error: err.message },
            err.status as 400 | 501,
          );
        }
        const errMessage = formatCaughtError(err);
        log.error(`memory add failed: ${errMessage}`, { error: errMessage });
        return c.json({ error: "add failed" }, 502);
      }
    },
  );
}
