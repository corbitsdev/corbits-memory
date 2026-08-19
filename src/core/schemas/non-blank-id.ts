import { type } from "arktype";

/**
 * `"string >= 1"` is a LENGTH constraint, not a content one — `" "` has
 * length 1 and would pass it, seating/accepting a whitespace-only id exactly
 * like the empty-string case such a schema exists to reject. Require at
 * least one non-whitespace character instead.
 *
 * Shared by the resolved-caller trust boundary (`routes/deps.ts`, CL-6286)
 * and the retention path-param schemas (`http-bodies.ts`, CL-6288) so the
 * fix lives in one schema instead of a comment repeated at each call site.
 */
export const NonBlankId = type("string").narrow(
  (s, ctx) => s.trim().length > 0 || ctx.mustBe("non-blank (not just whitespace)"),
);
