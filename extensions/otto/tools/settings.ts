/**
 * Settings tools — read/write workspace configuration stored in Supabase.
 */

import { Type } from "@sinclair/typebox";
import type { OttoExtClient } from "../lib/client.js";
import { textResult, errorResult, toJson } from "../lib/client.js";

export function buildSettingsTools(client: OttoExtClient) {
  const { supabase, workspaceId } = client;

  // ── settings_get ─────────────────────────────────────────────────────────
  const settings_get = {
    name: "settings_get",
    label: "Settings: Get",
    description:
      "Get workspace settings including autonomy level, contact rules, and notification preferences.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: Record<string, unknown>) {
      try {
        // Exclude llm_config to avoid exposing stored API keys to the agent
        const { data, error } = await supabase
          .from("user_config")
          .select(
            "workspace_id, autonomy_level, contact_rules, notification_preferences, created_at, updated_at",
          )
          .eq("workspace_id", workspaceId)
          .single();
        if (error) {
          if (error.code === "PGRST116") {
            return textResult("No settings found — using defaults.");
          }
          return errorResult(error.message);
        }
        return textResult(toJson(data));
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── settings_update ───────────────────────────────────────────────────────
  const settings_update = {
    name: "settings_update",
    label: "Settings: Update",
    description: "Update workspace settings. Pass only the keys you want to change.",
    parameters: Type.Object({
      autonomyLevel: Type.Optional(
        Type.String({
          description:
            'Agent autonomy: "propose" (suggest actions), "auto" (execute automatically), "silent" (no proactive actions)',
        }),
      ),
      contactRules: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Contact handling rules (JSON object)",
        }),
      ),
      notificationPreferences: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Notification preferences (JSON object)",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const autonomyLevel = params.autonomyLevel as string | undefined;
      if (autonomyLevel !== undefined && !["propose", "auto", "silent"].includes(autonomyLevel)) {
        return errorResult('autonomyLevel must be "propose", "auto", or "silent"');
      }
      try {
        const updates: Record<string, unknown> = {};
        if (autonomyLevel !== undefined) {
          updates.autonomy_level = autonomyLevel;
        }
        if (params.contactRules !== undefined) {
          updates.contact_rules = params.contactRules;
        }
        if (params.notificationPreferences !== undefined) {
          updates.notification_preferences = params.notificationPreferences;
        }

        if (Object.keys(updates).length === 0) {
          return textResult("No settings to update.");
        }

        // Upsert — create row if it doesn't exist; exclude llm_config from response
        const { data, error } = await supabase
          .from("user_config")
          .upsert({ workspace_id: workspaceId, ...updates })
          .select(
            "workspace_id, autonomy_level, contact_rules, notification_preferences, created_at, updated_at",
          )
          .single();
        if (error) {
          return errorResult(error.message);
        }
        return textResult(`Settings updated:\n${toJson(data)}`);
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  return [settings_get, settings_update];
}
