import { join } from "node:path";

/** Path to Otto repo scripts directory. Configurable via OTTO_SCRIPTS_DIR env var. */
export const OTTO_SCRIPTS_DIR =
  process.env.OTTO_SCRIPTS_DIR ??
  join(process.env.HOME ?? "/tmp", "Documents/GitHub/Otto/scripts/messaging");
