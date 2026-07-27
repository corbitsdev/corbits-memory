import { getLogger } from "@intx/log";

/** Category-bound logger for the knowledge engine (uses the host's sinks). */
export const log = getLogger(["knowledge-engine"]);

// Some `@intx/log` sinks do not render a call's context object into the
// terminal/aggregator output — only the message string is guaranteed to
// reach a human. Every catch site in the search path must therefore
// interpolate the caught error's detail directly into the log message
// template, not rely solely on passing it as a structured context field.
// This is the single place that formats "whatever got thrown" into a string
// worth reading, so every call site produces the same shape.
export function formatCaughtError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
