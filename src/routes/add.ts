import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import { resolveAccessTags, type ShareSugar } from "../acl.ts";
import { KnowledgeError } from "../knowledge.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard, requirePrincipal } from "./deps.ts";

const ShareBody = type({
  "tenant?": "boolean",
  "principals?": "string[]",
  "tags?": "string[]",
});

const AddRequest = type({
  title: "string >= 1",
  text: "string >= 1",
  /** Explicit resource tags (grant-pattern space). */
  "access_tags?": "string[]",
  /** Share sugar — mints tags only. */
  "share?": ShareBody,
});

const AddResponse = type({
  documentId: "string",
});

export function mountAddRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.post(
    "/api/knowledge/add",
    describeRoute({
      tags: ["knowledge"],
      summary: "Add a note into the knowledge base",
      responses: {
        200: {
          description: "Added",
          content: {
            "application/json": { schema: resolver(AddResponse) },
          },
        },
        400: { description: "Invalid request or access tags" },
        401: { description: "No principal on the request context" },
        403: { description: "Missing the knowledge:add grant" },
        502: { description: "add failed" },
      },
    }),
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
        const { documentId } = await deps.knowledge.add({
          content: { title, text },
          tenantId: scopeId,
          principalId: subjectId,
          ...(accessTags !== undefined ? { accessTags } : {}),
          ...(share !== undefined ? { share } : {}),
        });
        return c.json({ documentId });
      } catch (err) {
        if (err instanceof KnowledgeError) {
          return c.json(
            { error: err.message },
            err.status as 400 | 501,
          );
        }
        const errMessage = formatCaughtError(err);
        log.error(`knowledge add failed: ${errMessage}`, { error: errMessage });
        return c.json({ error: "add failed" }, 502);
      }
    },
  );
}
