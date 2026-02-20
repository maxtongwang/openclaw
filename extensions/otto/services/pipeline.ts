/**
 * Otto Pipeline Service
 *
 * Replaces launchd plists for Gmail polling, notification queue processing,
 * and daily digest. Registers as an OpenClaw managed service so it starts
 * and stops with the gateway lifecycle.
 *
 * Architecture:
 * - Gmail poll (every 15 min): spawns existing gmail-watcher.js + process-notify-queue.js
 * - Daily digest (8pm PST): spawns send-digest.js once per day
 *
 * The existing scripts remain the source of truth for business logic; this
 * service just manages their lifecycle instead of launchd.
 */

import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { spawn } from "node:child_process";
import { join } from "node:path";

/** Path to Otto repo scripts directory. Configurable via OTTO_SCRIPTS_DIR env var. */
const OTTO_SCRIPTS_DIR =
  process.env.OTTO_SCRIPTS_DIR ??
  join(process.env.HOME ?? "/tmp", "Documents/GitHub/Otto/scripts/messaging");

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DIGEST_HOUR_PST = 20; // 8pm PST

/** Run a script and resolve when it exits. Rejects on non-zero exit. */
function runScript(
  ctx: OpenClawPluginServiceContext,
  scriptPath: string,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.logger.debug(`[otto-pipeline] Starting ${label}`);
    const proc = spawn("node", [scriptPath], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        ctx.logger.debug(`[${label}] ${line}`);
      }
    });
    proc.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        ctx.logger.warn(`[${label}] ${line}`);
      }
    });

    proc.on("error", (err) => {
      ctx.logger.error(`[otto-pipeline] ${label} failed to start: ${err.message}`);
      reject(err);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        ctx.logger.debug(`[otto-pipeline] ${label} exited cleanly`);
        resolve();
      } else {
        ctx.logger.warn(`[otto-pipeline] ${label} exited with code ${code}`);
        // Resolve rather than reject — a non-zero exit from a single poll
        // should not crash the service; next interval will retry.
        resolve();
      }
    });
  });
}

/** Run one Gmail poll cycle: watcher then notify queue. */
async function runGmailPoll(ctx: OpenClawPluginServiceContext): Promise<void> {
  const watcherScript = join(OTTO_SCRIPTS_DIR, "gmail-watcher.js");
  const notifyScript = join(OTTO_SCRIPTS_DIR, "process-notify-queue.js");

  try {
    await runScript(ctx, watcherScript, "gmail-watcher");
    await runScript(ctx, notifyScript, "process-notify-queue");
  } catch (err) {
    ctx.logger.error(`[otto-pipeline] Gmail poll error: ${String(err)}`);
  }
}

/** Check if it's time to send the daily digest (8pm PST, once per calendar day). */
function isDailyDigestTime(lastDigestDate: string | null): boolean {
  const now = new Date();
  // Convert to PST (UTC-8 standard, UTC-7 daylight)
  const pstOffset = -8; // use standard time; digest window is wide enough
  const pstHour = (now.getUTCHours() + 24 + pstOffset) % 24;
  const pstDate = new Date(now.getTime() + pstOffset * 3600 * 1000).toISOString().split("T")[0];

  if (pstHour !== DIGEST_HOUR_PST) {
    return false;
  }
  if (lastDigestDate === pstDate) {
    return false;
  } // already ran today
  return true;
}

export function buildPipelineService() {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let digestTimer: ReturnType<typeof setInterval> | null = null;
  let lastDigestDate: string | null = null;

  return {
    id: "otto-pipeline",

    async start(ctx: OpenClawPluginServiceContext) {
      ctx.logger.info("[otto-pipeline] Starting — Gmail poller + daily digest");

      // Initial poll shortly after startup (give gateway 30s to settle)
      const initialDelay = setTimeout(() => {
        void runGmailPoll(ctx);
      }, 30_000);

      // Recurring poll every 15 minutes
      pollTimer = setInterval(() => {
        void runGmailPoll(ctx);
      }, POLL_INTERVAL_MS);

      // Daily digest: check every minute if it's time
      digestTimer = setInterval(() => {
        if (isDailyDigestTime(lastDigestDate)) {
          const digestScript = join(OTTO_SCRIPTS_DIR, "send-digest.js");
          lastDigestDate = new Date().toISOString().split("T")[0];
          void runScript(ctx, digestScript, "send-digest");
        }
      }, 60_000);

      // Store initialDelay ref so stop() can clear it if needed
      (ctx as Record<string, unknown>)._initialDelay = initialDelay;

      ctx.logger.info(
        `[otto-pipeline] Scheduled: poll every ${POLL_INTERVAL_MS / 60_000}m, digest at ${DIGEST_HOUR_PST}:00 PST`,
      );
    },

    async stop(ctx: OpenClawPluginServiceContext) {
      const delay = (ctx as Record<string, unknown>)._initialDelay;
      if (delay) {
        clearTimeout(delay as ReturnType<typeof setTimeout>);
      }
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      if (digestTimer) {
        clearInterval(digestTimer);
      }
      ctx.logger.info("[otto-pipeline] Stopped");
    },
  };
}
