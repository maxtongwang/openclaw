/**
 * Otto Source + Import Tools
 *
 * contact_sync  — trigger a Google Contacts import into the CRM (spawns contact-sync.js)
 * source_status — show last sync timestamp and result from source_configs table
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { OttoExtClient } from "../lib/client.js";
import { errorResult, textResult } from "../lib/client.js";
import { OTTO_SCRIPTS_DIR } from "../lib/paths.js";

const CONTACT_SYNC_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const VALID_SOURCES = ["contacts", "gmail", "calendar", "imessage"] as const;

/**
 * Spawn contact-sync.js and return its JSON result line.
 * Rejects on spawn error or if the process does not finish within 5 minutes.
 */
function runContactSync(workspaceId: string): Promise<{
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(OTTO_SCRIPTS_DIR, "contact-sync.js");
    const proc = spawn("node", [scriptPath], {
      env: { ...process.env, OTTO_WORKSPACE_ID: workspaceId },
      cwd: OTTO_SCRIPTS_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Kill process and reject if it exceeds the timeout
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("contact-sync timed out after 5 minutes"));
    }, CONTACT_SYNC_TIMEOUT_MS);

    const lines: string[] = [];
    proc.stdout.on("data", (d: Buffer) => {
      lines.push(...d.toString().split("\n").filter(Boolean));
    });
    proc.stderr.on("data", (d: Buffer) => {
      // Forward stderr to gateway logs
      for (const line of d.toString().split("\n").filter(Boolean)) {
        process.stderr.write(`[contact-sync] ${line}\n`);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // Last JSON-looking line is the result summary
      const last = lines.findLast((l) => l.startsWith("{"));
      if (last) {
        try {
          resolve(
            JSON.parse(last) as {
              imported: number;
              updated: number;
              skipped: number;
              errors: string[];
            },
          );
          return;
        } catch {
          // fall through
        }
      }
      if (code !== 0) {
        reject(new Error(`contact-sync exited with code ${code}`));
      } else {
        // Script exited 0 but produced no JSON summary — treat as empty run
        process.stderr.write("[contact-sync] No JSON summary line in output\n");
        resolve({ imported: 0, updated: 0, skipped: 0, errors: [] });
      }
    });
  });
}

export function buildSourceTools(client: OttoExtClient) {
  const { supabase, workspaceId } = client;

  return [
    // ── contact_sync ────────────────────────────────────────────────────────
    {
      name: "contact_sync",
      description:
        "Import contacts from Google People API into the Otto CRM. " +
        "Upserts contacts as entities, merging with any existing records matched by email or phone. " +
        "Returns a summary of imported, updated, skipped, and errored contacts.",
      inputSchema: {
        type: "object" as const,
        properties: {
          dry_run: {
            type: "boolean",
            description:
              "If true, verify that a Google OAuth token is present and report its account email " +
              "and expiry without importing any contacts. Defaults to false.",
          },
        },
        required: [],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const dryRun = params.dry_run === true;

        if (dryRun) {
          // Verify token presence only — scoped to workspace to prevent cross-tenant leaks
          const { data: tokenRow } = await supabase
            .from("user_tokens")
            .select("account_email, expires_at")
            .eq("workspace_id", workspaceId)
            .eq("provider", "google")
            .limit(1)
            .maybeSingle();

          if (!tokenRow) {
            return errorResult("No Google OAuth token found. Run Google auth setup first.");
          }

          return textResult(
            `Dry run: Google account ${String(tokenRow.account_email)} token expires at ${String(tokenRow.expires_at)}. ` +
              "Run contact_sync without dry_run to import contacts.",
          );
        }

        try {
          const result = await runContactSync(workspaceId);
          const summary =
            `Contact sync complete:\n` +
            `- Imported: ${result.imported}\n` +
            `- Updated: ${result.updated}\n` +
            `- Skipped: ${result.skipped}\n` +
            (result.errors.length > 0
              ? `- Errors (${result.errors.length}): ${result.errors.slice(0, 5).join("; ")}${result.errors.length > 5 ? ` (+${result.errors.length - 5} more)` : ""}`
              : "- No errors");
          return textResult(summary);
        } catch (err) {
          return errorResult(`Contact sync failed: ${String(err)}`);
        }
      },
    },

    // ── source_status ───────────────────────────────────────────────────────
    {
      name: "source_status",
      description:
        "Show the last sync timestamp and result for each configured data source " +
        "(contacts, gmail, calendar, imessage). Useful for checking when data was last refreshed.",
      inputSchema: {
        type: "object" as const,
        properties: {
          source: {
            type: "string",
            description:
              "Filter to a specific source type: contacts, gmail, calendar, or imessage. Omit to show all.",
          },
        },
        required: [],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        // Validate source filter against allowlist
        const source = params.source as string | undefined;
        if (
          source !== undefined &&
          !VALID_SOURCES.includes(source as (typeof VALID_SOURCES)[number])
        ) {
          return errorResult(
            `Unknown source "${source}". Must be one of: ${VALID_SOURCES.join(", ")}.`,
          );
        }

        let query = supabase
          .from("source_configs")
          .select("source_type, state, updated_at")
          .eq("workspace_id", workspaceId)
          .order("source_type");

        if (source) {
          query = query.eq("source_type", source);
        }

        const { data, error } = await query;
        if (error) {
          return errorResult(`Failed to fetch source status: ${error.message}`);
        }

        if (!data || data.length === 0) {
          return textResult(
            "No sync history found. Run contact_sync or start the pipeline service to begin.",
          );
        }

        const lines = data.map((row) => {
          const state = row.state as Record<string, unknown> | null;
          const lastSync = state?.lastSyncAt
            ? new Date(state.lastSyncAt as string).toISOString()
            : "never";
          const lastResult = state?.lastResult as Record<string, unknown> | null;
          const summary = lastResult
            ? ` — imported:${Number(lastResult.imported ?? 0)} updated:${Number(lastResult.updated ?? 0)} errors:${Number(lastResult.errorCount ?? 0)}`
            : "";
          return `${row.source_type}: last sync ${lastSync}${summary}`;
        });

        return textResult(lines.join("\n"));
      },
    },
  ];
}
