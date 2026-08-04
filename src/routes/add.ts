import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { formatCaughtError, log } from "../log.ts";
import { parseAcl } from "../acl.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard, requirePrincipal } from "./deps.ts";

const AddRequest = type({
  title: "string >= 1",
  text: "string >= 1",
  "acl?": "unknown",
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
        400: { description: "Invalid request or ACL" },
        401: { description: "No principal on the request context" },
        403: { description: "Missing the knowledge:add grant" },
        502: { description: "add failed" },
      },
    }),
    requirePrincipal(),
    grantGuard(deps, "add"),
    validator("json", AddRequest),
    async (c) => {
      const { title, text, acl } = c.req.valid("json");
      const { scopeId, subjectId } = caller(c);

      const parsed = parseAcl(acl, subjectId);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);

      try {
        const { documentId } = await deps.knowledge.add({
          content: { title, text },
          tenantId: scopeId,
          principalId: subjectId,
          visibility: parsed.visibility,
          blockPrincipalIds: parsed.block,
        });
        return c.json({ documentId });
      } catch (err) {
        const errMessage = formatCaughtError(err);
        log.error(`knowledge add failed: ${errMessage}`, { error: errMessage });
        return c.json({ error: "add failed" }, 502);
      }
    },
  );
}
