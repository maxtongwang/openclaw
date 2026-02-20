/**
 * Otto CRM Extension for OpenClaw
 *
 * Provides CRM tools, context injection, and pipeline services for the Otto
 * real-estate relationship platform. All Otto domain data lives in Supabase;
 * OpenClaw handles sessions, memory, and channel routing.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createClient } from "@supabase/supabase-js";
import type { OttoExtClient } from "./lib/client.js";
import { buildSlashCommand } from "./commands/slash.js";
import { buildContextInjectionHook } from "./hooks/context-injection.js";
import { buildComposeTools } from "./tools/compose.js";
import { buildCrmTools } from "./tools/crm.js";
import { buildGmailTools } from "./tools/gmail.js";
import { buildSettingsTools } from "./tools/settings.js";
import { buildTaskTools } from "./tools/tasks.js";

type OttoConfig = {
  supabaseUrl: string;
  supabaseServiceKey: string;
  workspaceId: string;
};

function assertOttoConfig(config: unknown): OttoConfig {
  if (!config || typeof config !== "object") {
    throw new Error("Otto: plugin config is missing");
  }
  const c = config as Record<string, unknown>;
  if (typeof c.supabaseUrl !== "string" || !c.supabaseUrl) {
    throw new Error("Otto: supabaseUrl is required");
  }
  if (typeof c.supabaseServiceKey !== "string" || !c.supabaseServiceKey) {
    throw new Error("Otto: supabaseServiceKey is required");
  }
  if (typeof c.workspaceId !== "string" || !c.workspaceId) {
    throw new Error("Otto: workspaceId is required");
  }
  return {
    supabaseUrl: c.supabaseUrl,
    supabaseServiceKey: c.supabaseServiceKey,
    workspaceId: c.workspaceId,
  };
}

export default function register(api: OpenClawPluginApi) {
  const cfg = assertOttoConfig(api.pluginConfig);

  // Supabase client for all Otto domain queries
  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, {
    auth: { persistSession: false },
  });

  const client: OttoExtClient = {
    supabase,
    workspaceId: cfg.workspaceId,
  };

  api.logger.info(`Otto extension loaded (workspaceId=${cfg.workspaceId}, url=${cfg.supabaseUrl})`);

  // Build tool arrays once — used for both registration and count
  const crmTools = buildCrmTools(client);
  const taskTools = buildTaskTools(client);
  const composeTools = buildComposeTools(client);
  const gmailTools = buildGmailTools(client);
  const settingsTools = buildSettingsTools(client);

  // ── Register all tools ───────────────────────────────────────────────────
  for (const tool of [
    ...crmTools,
    ...taskTools,
    ...composeTools,
    ...gmailTools,
    ...settingsTools,
  ]) {
    // oxlint-disable-next-line typescript/no-explicit-any
    api.registerTool(tool as any);
  }

  api.logger.info(
    `Otto: registered ${crmTools.length + taskTools.length + composeTools.length + gmailTools.length + settingsTools.length} tools`,
  );

  // ── Register before_agent_start context injection ─────────────────────────
  api.on("before_agent_start", buildContextInjectionHook(client));

  // ── Register /otto slash command ─────────────────────────────────────────
  // oxlint-disable-next-line typescript/no-explicit-any
  api.registerCommand(buildSlashCommand(client) as any);

  // Phase 4: register pipeline service here
}
