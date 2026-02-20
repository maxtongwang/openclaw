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
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";

/** Path to Otto repo scripts directory. Configurable via OTTO_SCRIPTS_DIR env var. */
const OTTO_SCRIPTS_DIR =
  process.env.OTTO_SCRIPTS_DIR ??
  join(process.env.HOME ?? "/tmp", "Documents/GitHub/Otto/scripts/messaging");

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DIGEST_HOUR_PST = 20; // 8pm PST (note: 9pm local during PDT, Mar–Nov)
const PST_OFFSET_HOURS = -8;

/** Return the current date string in PST (YYYY-MM-DD). */
function pstDateString(): string {
  return new Date(Date.now() + PST_OFFSET_HOURS * 3600 * 1000).toISOString().split("T")[0];
}

/** Return the current hour in PST (0–23). */
function pstHour(): number {
  return (new Date().getUTCHours() + 24 + PST_OFFSET_HOURS) % 24;
}

/** Run a script and resolve when it exits. Rejects only on spawn errors. */
function runScript(
  ctx: OpenClawPluginServiceContext,
  scriptPath: string,
  label: string,
  activeProcs: Set<ChildProcess>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.logger.debug(`[otto-pipeline] Starting ${label}`);
    const proc = spawn("node", [scriptPath], {
      env: { ...process.env },
      cwd: dirname(scriptPath),
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeProcs.add(proc);

    proc.stdout.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        ctx.logger.debug(`[${label}] ${line}`);
      }
    });
    proc.stderr.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        ctx.logger.warn(`[${label}] ${line}`);
      }
    });

    proc.on("error", (err) => {
      activeProcs.delete(proc);
      ctx.logger.error(`[otto-pipeline] ${label} failed to start: ${err.message}`);
      reject(err);
    });

    proc.on("close", (code, signal) => {
      activeProcs.delete(proc);
      if (code === 0) {
        ctx.logger.debug(`[otto-pipeline] ${label} exited cleanly`);
      } else if (signal) {
        // Killed by stop() — expected, not an error
        ctx.logger.debug(`[otto-pipeline] ${label} killed with ${signal}`);
      } else {
        ctx.logger.warn(`[otto-pipeline] ${label} exited with code ${code}`);
      }
      // Resolve either way — a non-zero exit from a single poll should not
      // crash the service; next interval will retry.
      resolve();
    });
  });
}

/** Run one Gmail poll cycle: watcher then notify queue. */
async function runGmailPoll(
  ctx: OpenClawPluginServiceContext,
  activeProcs: Set<ChildProcess>,
): Promise<void> {
  try {
    await runScript(ctx, join(OTTO_SCRIPTS_DIR, "gmail-watcher.js"), "gmail-watcher", activeProcs);
    await runScript(
      ctx,
      join(OTTO_SCRIPTS_DIR, "process-notify-queue.js"),
      "process-notify-queue",
      activeProcs,
    );
  } catch (err) {
    ctx.logger.error(`[otto-pipeline] Gmail poll error: ${String(err)}`);
  }
}

export function buildPipelineService() {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let digestTimer: ReturnType<typeof setInterval> | null = null;
  let initialDelay: ReturnType<typeof setTimeout> | null = null;
  let lastDigestDate: string | null = null;
  let isPolling = false;
  const activeProcs = new Set<ChildProcess>();

  return {
    id: "otto-pipeline",

    async start(ctx: OpenClawPluginServiceContext) {
      ctx.logger.info("[otto-pipeline] Starting — Gmail poller + daily digest");

      // Initial poll shortly after startup (give gateway 30s to settle)
      initialDelay = setTimeout(() => {
        if (isPolling) {
          return;
        }
        isPolling = true;
        void runGmailPoll(ctx, activeProcs).finally(() => {
          isPolling = false;
        });
      }, 30_000);

      // Recurring poll every 15 minutes; skip if previous poll is still running
      pollTimer = setInterval(() => {
        if (isPolling) {
          ctx.logger.debug("[otto-pipeline] Skipping poll — previous run still active");
          return;
        }
        isPolling = true;
        void runGmailPoll(ctx, activeProcs).finally(() => {
          isPolling = false;
        });
      }, POLL_INTERVAL_MS);

      // Daily digest: check every minute; fire once per PST calendar day at 8pm
      digestTimer = setInterval(() => {
        if (pstHour() !== DIGEST_HOUR_PST) {
          return;
        }
        const today = pstDateString();
        if (lastDigestDate === today) {
          return;
        }
        lastDigestDate = today;
        runScript(ctx, join(OTTO_SCRIPTS_DIR, "send-digest.js"), "send-digest", activeProcs).catch(
          (err: unknown) =>
            ctx.logger.error(`[otto-pipeline] send-digest failed to start: ${String(err)}`),
        );
      }, 60_000);

      ctx.logger.info(
        `[otto-pipeline] Scheduled: poll every ${POLL_INTERVAL_MS / 60_000}m, digest at ${DIGEST_HOUR_PST}:00 PST`,
      );
    },

    async stop(ctx: OpenClawPluginServiceContext) {
      if (initialDelay) {
        clearTimeout(initialDelay);
      }
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      if (digestTimer) {
        clearInterval(digestTimer);
      }
      // Kill any in-flight child processes so they don't outlive the service
      for (const proc of activeProcs) {
        proc.kill("SIGTERM");
      }
      activeProcs.clear();
      ctx.logger.info("[otto-pipeline] Stopped");
    },
  };
}
