import { getLogger } from "@intx/log";

/** Category-bound logger for the knowledge engine (uses the host's sinks). */
export const log = getLogger(["knowledge-engine"]);
