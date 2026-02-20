/**
 * Task management tools for Otto extension.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { Type } from "@sinclair/typebox";
import { textResult, errorResult, toJson } from "../lib/client.js";

export function buildTaskTools(supabase: SupabaseClient, getWorkspaceId: () => Promise<string>) {
  // ── crm_create_task ──────────────────────────────────────────────────────
  const crm_create_task = {
    name: "crm_create_task",
    label: "CRM: Create Task",
    description: "Create a task or reminder optionally linked to a CRM entity.",
    parameters: Type.Object({
      title: Type.String({ description: "Task title" }),
      description: Type.Optional(Type.String({ description: "Task details" })),
      dueAt: Type.Optional(
        Type.String({
          description: "Due date/time in ISO 8601 format (e.g. 2025-03-01T10:00:00Z)",
        }),
      ),
      entityId: Type.Optional(Type.String({ description: "CRM entity UUID to link this task to" })),
      priority: Type.Optional(
        Type.String({
          description: 'Priority: "low", "medium", "high" (default: "medium")',
        }),
      ),
      reminderAt: Type.Optional(
        Type.String({ description: "Reminder date/time in ISO 8601 format" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceId = await getWorkspaceId();
      const title = params.title as string;
      const description = params.description as string | undefined;
      const dueAt = params.dueAt as string | undefined;
      const entityId = params.entityId as string | undefined;
      const priority = (params.priority as string) ?? "medium";
      const reminderAt = params.reminderAt as string | undefined;

      // Validate priority
      if (!["low", "medium", "high"].includes(priority)) {
        return errorResult('Priority must be "low", "medium", or "high"');
      }
      // Validate dates
      if (dueAt && isNaN(Date.parse(dueAt))) {
        return errorResult(`Invalid dueAt date: ${dueAt}`);
      }
      if (reminderAt && isNaN(Date.parse(reminderAt))) {
        return errorResult(`Invalid reminderAt date: ${reminderAt}`);
      }

      try {
        // If entityId provided, validate it belongs to this workspace
        if (entityId) {
          const { data: entity, error: entityErr } = await supabase
            .from("entities")
            .select("id")
            .eq("id", entityId)
            .eq("workspace_id", workspaceId)
            .maybeSingle();
          if (entityErr) return errorResult(entityErr.message);
          if (!entity) return errorResult("Entity not found in this workspace.");
        }

        const { data, error } = await supabase
          .from("tasks")
          .insert({
            workspace_id: workspaceId,
            title,
            description,
            due_at: dueAt ?? null,
            entity_id: entityId ?? null,
            priority,
            reminder_at: reminderAt ?? null,
            status: "pending",
          })
          .select()
          .single();
        if (error) {
          return errorResult(error.message);
        }
        return textResult(`Task created:\n${toJson(data)}`);
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_list_tasks ───────────────────────────────────────────────────────
  const crm_list_tasks = {
    name: "crm_list_tasks",
    label: "CRM: List Tasks",
    description: "List pending or upcoming tasks, optionally filtered by entity.",
    parameters: Type.Object({
      entityId: Type.Optional(Type.String({ description: "Filter by CRM entity UUID" })),
      status: Type.Optional(
        Type.String({
          description: 'Filter by status: "pending", "done", "cancelled" (default: "pending")',
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceId = await getWorkspaceId();
      const entityId = params.entityId as string | undefined;
      const status = (params.status as string) ?? "pending";
      const limit = (params.limit as number) ?? 20;
      try {
        let q = supabase
          .from("tasks")
          .select("*")
          .eq("workspace_id", workspaceId)
          .eq("status", status)
          .order("due_at", { ascending: true, nullsFirst: false })
          .limit(limit);

        if (entityId) {
          q = q.eq("entity_id", entityId);
        }

        const { data, error } = await q;
        if (error) {
          return errorResult(error.message);
        }
        if (!data?.length) {
          return textResult("No tasks found.");
        }
        return textResult(toJson(data));
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_complete_task ────────────────────────────────────────────────────
  const crm_complete_task = {
    name: "crm_complete_task",
    label: "CRM: Complete Task",
    description: "Mark a task as done.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task UUID" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const workspaceId = await getWorkspaceId();
      const taskId = params.taskId as string;
      try {
        const { error } = await supabase
          .from("tasks")
          .update({ status: "done", completed_at: new Date().toISOString() })
          .eq("id", taskId)
          .eq("workspace_id", workspaceId);
        if (error) {
          return errorResult(error.message);
        }
        return textResult(`Task ${taskId} marked as done.`);
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  return [crm_create_task, crm_list_tasks, crm_complete_task];
}
