import { join } from "node:path";

/** Path to Otto repo scripts directory. Configurable via OTTO_SCRIPTS_DIR env var. */
export const OTTO_SCRIPTS_DIR =
  process.env.OTTO_SCRIPTS_DIR ??
  join(process.env.HOME ?? "/tmp", "Documents/GitHub/Otto/scripts/messaging");

/** Contact sync timeout: 5 minutes. */
export const CONTACT_SYNC_TIMEOUT_MS = 5 * 60 * 1000;
