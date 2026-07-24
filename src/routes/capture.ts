import type { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { log } from "../log.ts";
import { parseAcl } from "../acl.ts";
import type { RouteDeps } from "./deps.ts";
import { caller, grantGuard } from "./deps.ts";

const CaptureRequest = type({
  title: "string >= 1",
  text: "string >= 1",
  "acl?": "unknown",
});

const CaptureResponse = type({ status: "'captured'" });

export function mountCaptureRoute(app: Hono<TenantEnv>, deps: RouteDeps): void {
  app.post(
    "/api/knowledge/capture",
    describeRoute({
      tags: ["knowledge"],
      summary: "Capture a note into the knowledge base",
      responses: {
        200: {
          description: "Captured",
          content: {
            "application/json": { schema: resolver(CaptureResponse) },
          },
        },
        400: { description: "Invalid request or ACL" },
        403: { description: "Missing the knowledge:capture grant" },
      },
    }),
    grantGuard(deps, "capture"),
    validator("json", CaptureRequest),
    async (c) => {
      const { title, text, acl } = c.req.valid("json");
      const { scopeId, subjectId } = caller(c);

      const parsed = parseAcl(acl, subjectId);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);

      try {
        await deps.knowledge.capture({
          title,
          text,
          tenantId: scopeId,
          principalId: subjectId,
          visibility: parsed.visibility,
          blockPrincipalIds: parsed.block,
        });
        deps.captureLog.record({
          at: new Date().toISOString(),
          title,
          source: "api",
          tenantId: scopeId,
          principalId: subjectId,
        });
        return c.json({ status: "captured" });
      } catch (err) {
        log.error("knowledge capture failed", { err });
        return c.json({ error: "capture failed" }, 502);
      }
    },
  );
}
