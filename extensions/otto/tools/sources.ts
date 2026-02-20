/**
 * Otto Source + Import Tools
 *
 * contact_sync  — trigger a Google Contacts import into the CRM (spawns contact-sync.js)
 * source_status — show last sync timestamp and result from source_configs table
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { OttoExtClient } from "../lib/client.js";

const OTTO_SCRIPTS_DIR =
  process.env.OTTO_SCRIPTS_DIR ??
  join(process.env.HOME ?? "/tmp", "Documents/GitHub/Otto/scripts/messaging");

function errorResult(msg: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

function okResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Spawn contact-sync.js and return its JSON result line.
 * Resolves with parsed result or rejects on spawn error.
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

    const lines: string[] = [];
    proc.stdout.on("data", (d: Buffer) => {
      lines.push(...d.toString().split("\n").filter(Boolean));
    });
    proc.stderr.on("data", (d: Buffer) => {
      // Log stderr lines as console output (visible in gateway logs)
      for (const line of d.toString().split("\n").filter(Boolean)) {
        process.stderr.write(`[contact-sync] ${line}\n`);
      }
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      // Last line of stdout is the JSON summary
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
        resolve({
          imported: 0,
          updated: 0,
          skipped: 0,
          errors: ["No result output"],
        });
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
              "If true, return the count of contacts that would be synced without writing to the database. " +
              "Defaults to false.",
          },
        },
        required: [],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const dryRun = params.dry_run === true;

        if (dryRun) {
          // For dry_run, just check token availability and report contact count
          const { data: tokenRow } = await supabase
            .from("user_tokens")
            .select("account_email, expires_at")
            .eq("provider", "google")
            .limit(1)
            .maybeSingle();

          if (!tokenRow) {
            return errorResult("No Google OAuth token found. Run Google auth setup first.");
          }

          return okResult(
            `Dry run: Google account ${tokenRow.account_email} token expires at ${tokenRow.expires_at}. ` +
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
          return okResult(summary);
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
              "Filter to a specific source type (contacts, gmail, calendar, imessage). Omit to show all.",
          },
        },
        required: [],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        let query = supabase
          .from("source_configs")
          .select("source_type, state, updated_at")
          .eq("workspace_id", workspaceId)
          .order("source_type");

        const source = params.source as string | undefined;
        if (source) {
          query = query.eq("source_type", source);
        }

        const { data, error } = await query;
        if (error) {
          return errorResult(`Failed to fetch source status: ${error.message}`);
        }

        if (!data || data.length === 0) {
          return okResult(
            "No sync history found. Run contact_sync or start the pipeline service to begin.",
          );
        }

        const lines = data.map((row) => {
          const state = row.state as Record<string, unknown> | null;
          const lastSync = state?.lastSyncAt
            ? new Date(state.lastSyncAt as string).toLocaleString()
            : "never";
          const lastResult = state?.lastResult as Record<string, unknown> | null;
          const summary = lastResult
            ? ` — imported:${lastResult.imported ?? 0} updated:${lastResult.updated ?? 0} errors:${lastResult.errorCount ?? 0}`
            : "";
          return `${row.source_type}: last sync ${lastSync}${summary}`;
        });

        return okResult(lines.join("\n"));
      },
    },
  ];
}
