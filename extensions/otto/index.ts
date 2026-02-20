/**
 * Otto CRM Extension for OpenClaw
 *
 * Provides CRM tools, context injection, and pipeline services for the Otto
 * real-estate relationship platform. All Otto domain data lives in Supabase;
 * OpenClaw handles sessions, memory, and channel routing.
 */

import { createClient } from "@supabase/supabase-js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

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

  api.logger.info(`Otto extension loaded (workspaceId=${cfg.workspaceId}, url=${cfg.supabaseUrl})`);

  // Phase 2: register CRM tools here
  // Phase 2: register before_agent_start context injection hook here
  // Phase 3: register /otto slash command here
  // Phase 4: register pipeline service here

  // Expose supabase client to future tool registrations (captured in closure)
  void supabase; // referenced by future tool registrations
}
