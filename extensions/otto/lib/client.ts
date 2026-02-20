/**
 * Shared Supabase client wrapper for Otto extension tools.
 * All tools receive this client and workspaceId via closure from index.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface OttoExtClient {
  supabase: SupabaseClient;
  workspaceId: string;
}

/** Format a tool result as text content */
export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Format an error result */
export function errorResult(msg: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

/** Truncate and serialize a value for tool output */
export function toJson(value: unknown, maxLen = 8000): string {
  const s = JSON.stringify(value, null, 2);
  if (s.length > maxLen) {
    return s.slice(0, maxLen) + "\n... (truncated)";
  }
  return s;
}
