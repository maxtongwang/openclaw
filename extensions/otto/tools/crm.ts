/**
 * CRM entity/edge/tag/dedup tools for Otto extension.
 * Each tool is a plain AgentTool object registered via api.registerTool().
 * All Supabase operations mirror packages/core/src/entities/, edges/, tags/.
 */

import { Type } from "@sinclair/typebox";
import type { OttoExtClient } from "../lib/client.js";
import { textResult, errorResult, toJson } from "../lib/client.js";

export function buildCrmTools(client: OttoExtClient) {
  const { supabase, workspaceId } = client;

  // ── crm_search_entities ──────────────────────────────────────────────────
  const crm_search_entities = {
    name: "crm_search_entities",
    label: "CRM: Search Entities",
    description:
      "Full-text search for contacts, companies, deals, properties, or any CRM entity by name, description, or metadata. Returns up to 20 matches.",
    parameters: Type.Object({
      query: Type.String({ description: "Search text" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 20)" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const query = params.query as string;
      const limit = Math.min((params.limit as number | undefined) ?? 10, 20);
      try {
        const { data, error } = await supabase
          .rpc("search_entities", {
            p_workspace_id: workspaceId,
            p_query: query,
          })
          .limit(limit);
        if (error) {
          return errorResult(error.message);
        }
        if (!data?.length) {
          return textResult("No entities found.");
        }
        const results = (data as Array<Record<string, unknown>>).map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type_name ?? e.type_id,
          description: e.description,
          metadata: e.metadata,
        }));
        return textResult(toJson(results));
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_get_entity ───────────────────────────────────────────────────────
  const crm_get_entity = {
    name: "crm_get_entity",
    label: "CRM: Get Entity",
    description:
      "Fetch a CRM entity by ID with its type info, metadata, tags, and connected entities.",
    parameters: Type.Object({
      id: Type.String({ description: "Entity UUID" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const entityId = params.id as string;
      try {
        const [entityRes, connectionsRes, tagsRes] = await Promise.all([
          supabase
            .from("entities")
            .select("*, entity_types(name, display_name, icon, color)")
            .eq("id", entityId)
            .single(),
          supabase.rpc("get_connected_entities", { p_entity_id: entityId }),
          supabase.from("entity_tags").select("tags(name, color)").eq("entity_id", entityId),
        ]);
        if (entityRes.error) {
          if (entityRes.error.code === "PGRST116") {
            return textResult("Entity not found.");
          }
          return errorResult(entityRes.error.message);
        }
        const result = {
          ...entityRes.data,
          connections: connectionsRes.data ?? [],
          tags: (tagsRes.data ?? []).map(
            (t: Record<string, unknown>) => (t.tags as Record<string, unknown>)?.name,
          ),
        };
        return textResult(toJson(result));
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_create_entity ────────────────────────────────────────────────────
  const crm_create_entity = {
    name: "crm_create_entity",
    label: "CRM: Create Entity",
    description:
      "Create a new CRM entity (contact, company, deal, property, etc.). Returns the created entity with its ID.",
    parameters: Type.Object({
      typeName: Type.String({
        description: 'Entity type name (e.g., "contact", "company", "deal", "property")',
      }),
      name: Type.String({ description: "Entity display name" }),
      description: Type.Optional(Type.String({ description: "Optional description" })),
      metadata: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Type-specific fields (e.g., email, phone, address, price)",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const typeName = params.typeName as string;
      const name = params.name as string;
      const description = params.description as string | undefined;
      const metadata = (params.metadata as Record<string, unknown>) ?? {};
      try {
        // Resolve type ID
        const { data: typeRow, error: typeErr } = await supabase
          .from("entity_types")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("name", typeName)
          .single();
        if (typeErr || !typeRow) {
          return errorResult(
            `Entity type "${typeName}" not found. Use crm_search_entities or check available types.`,
          );
        }

        const { data, error } = await supabase
          .from("entities")
          .insert({
            workspace_id: workspaceId,
            type_id: typeRow.id,
            name,
            description,
            metadata,
          })
          .select()
          .single();
        if (error) {
          return errorResult(error.message);
        }
        return textResult(`Created entity:\n${toJson(data)}`);
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_update_entity ────────────────────────────────────────────────────
  const crm_update_entity = {
    name: "crm_update_entity",
    label: "CRM: Update Entity",
    description:
      "Update an existing CRM entity's name, description, or metadata fields. Only provided fields are changed.",
    parameters: Type.Object({
      id: Type.String({ description: "Entity UUID" }),
      name: Type.Optional(Type.String({ description: "New display name" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      metadata: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Metadata fields to merge (existing keys preserved unless overwritten)",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const entityId = params.id as string;
      const updates: Record<string, unknown> = {};
      if (params.name !== undefined) {
        updates.name = params.name;
      }
      if (params.description !== undefined) {
        updates.description = params.description;
      }

      try {
        // Merge metadata if provided
        if (params.metadata !== undefined) {
          const { data: existing } = await supabase
            .from("entities")
            .select("metadata")
            .eq("id", entityId)
            .single();
          updates.metadata = {
            ...(existing?.metadata as Record<string, unknown>),
            ...(params.metadata as Record<string, unknown>),
          };
        }

        if (Object.keys(updates).length === 0) {
          return textResult("No fields to update.");
        }

        const { data, error } = await supabase
          .from("entities")
          .update(updates)
          .eq("id", entityId)
          .select()
          .single();
        if (error) {
          return errorResult(error.message);
        }
        return textResult(`Updated entity:\n${toJson(data)}`);
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_log_interaction ──────────────────────────────────────────────────
  const crm_log_interaction = {
    name: "crm_log_interaction",
    label: "CRM: Log Interaction",
    description: "Log a call, meeting, note, or email interaction on a CRM entity.",
    parameters: Type.Object({
      entityId: Type.String({ description: "Entity UUID to log against" }),
      type: Type.String({
        description: 'Interaction type: "call", "meeting", "note", "email", "text"',
      }),
      title: Type.String({ description: "Short summary of the interaction" }),
      body: Type.Optional(Type.String({ description: "Detailed notes or transcript" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const entityId = params.entityId as string;
      const type = params.type as string;
      const title = params.title as string;
      const body = params.body as string | undefined;
      try {
        const { data, error } = await supabase
          .from("notifications")
          .insert({
            workspace_id: workspaceId,
            source: type,
            source_id: entityId,
            title,
            body,
            data: { logged_manually: true },
            read: true,
          })
          .select()
          .single();
        if (error) {
          return errorResult(error.message);
        }
        return textResult(`Logged ${type} on entity:\n${toJson(data)}`);
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_create_edge ──────────────────────────────────────────────────────
  const crm_create_edge = {
    name: "crm_create_edge",
    label: "CRM: Create Edge",
    description:
      "Create a relationship edge between two CRM entities (e.g., contact works_at company).",
    parameters: Type.Object({
      fromEntityId: Type.String({ description: "Source entity UUID" }),
      toEntityId: Type.String({ description: "Target entity UUID" }),
      edgeTypeName: Type.String({
        description: 'Edge type name (e.g., "works_at", "owns", "interested_in", "knows")',
      }),
      metadata: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Additional edge metadata",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const fromEntityId = params.fromEntityId as string;
      const toEntityId = params.toEntityId as string;
      const edgeTypeName = params.edgeTypeName as string;
      const metadata = (params.metadata as Record<string, unknown>) ?? {};
      try {
        const { data: edgeType, error: etErr } = await supabase
          .from("edge_types")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("name", edgeTypeName)
          .single();
        if (etErr || !edgeType) {
          return errorResult(`Edge type "${edgeTypeName}" not found.`);
        }

        const { data, error } = await supabase
          .from("edges")
          .insert({
            workspace_id: workspaceId,
            from_entity_id: fromEntityId,
            to_entity_id: toEntityId,
            type_id: edgeType.id,
            metadata,
          })
          .select()
          .single();
        if (error) {
          return errorResult(error.message);
        }
        return textResult(`Created edge:\n${toJson(data)}`);
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_delete_edge ──────────────────────────────────────────────────────
  const crm_delete_edge = {
    name: "crm_delete_edge",
    label: "CRM: Delete Edge",
    description: "Remove a relationship edge by its ID.",
    parameters: Type.Object({
      edgeId: Type.String({ description: "Edge UUID" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const edgeId = params.edgeId as string;
      try {
        const { error } = await supabase.from("edges").delete().eq("id", edgeId);
        if (error) {
          return errorResult(error.message);
        }
        return textResult(`Edge ${edgeId} deleted.`);
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_tag_entity ───────────────────────────────────────────────────────
  const crm_tag_entity = {
    name: "crm_tag_entity",
    label: "CRM: Tag Entity",
    description: "Add or remove tags on a CRM entity.",
    parameters: Type.Object({
      entityId: Type.String({ description: "Entity UUID" }),
      addTags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Tag names to add",
        }),
      ),
      removeTags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Tag names to remove",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const entityId = params.entityId as string;
      const addTags = (params.addTags as string[]) ?? [];
      const removeTags = (params.removeTags as string[]) ?? [];
      const results: string[] = [];
      try {
        for (const tagName of addTags) {
          // Upsert tag
          let { data: tag } = await supabase
            .from("tags")
            .select("id")
            .eq("workspace_id", workspaceId)
            .eq("name", tagName)
            .single();
          if (!tag) {
            const { data: newTag, error: tagErr } = await supabase
              .from("tags")
              .insert({ workspace_id: workspaceId, name: tagName })
              .select("id")
              .single();
            if (tagErr) {
              results.push(`Failed to create tag "${tagName}": ${tagErr.message}`);
              continue;
            }
            tag = newTag;
          }
          const tagId = (tag as { id: string } | null)?.id;
          if (!tagId) {
            results.push(`Skipping tag "${tagName}": no id returned`);
            continue;
          }
          const { error } = await supabase
            .from("entity_tags")
            .upsert({ entity_id: entityId, tag_id: tagId });
          if (error) {
            results.push(`Failed to add tag "${tagName}": ${error.message}`);
          } else {
            results.push(`Added tag "${tagName}"`);
          }
        }

        for (const tagName of removeTags) {
          const { data: tag } = await supabase
            .from("tags")
            .select("id")
            .eq("workspace_id", workspaceId)
            .eq("name", tagName)
            .single();
          if (!tag) {
            results.push(`Tag "${tagName}" not found (skipped)`);
            continue;
          }
          const { error } = await supabase
            .from("entity_tags")
            .delete()
            .eq("entity_id", entityId)
            .eq("tag_id", tag.id);
          if (error) {
            results.push(`Failed to remove tag "${tagName}": ${error.message}`);
          } else {
            results.push(`Removed tag "${tagName}"`);
          }
        }

        return textResult(results.join("\n") || "No changes.");
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_find_duplicates ──────────────────────────────────────────────────
  const crm_find_duplicates = {
    name: "crm_find_duplicates",
    label: "CRM: Find Duplicates",
    description:
      "Find likely duplicate entities in the CRM by comparing names, emails, and phone numbers.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({
          description: "Max duplicate pairs to return (default 10)",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const limit = (params.limit as number | undefined) ?? 10;
      try {
        const { data, error } = await supabase
          .rpc("find_duplicate_contacts", {
            p_workspace_id: workspaceId,
          })
          .limit(limit);
        if (error) {
          return errorResult(error.message);
        }
        if (!data?.length) {
          return textResult("No duplicate contacts found.");
        }
        return textResult(toJson(data));
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_merge_entities ───────────────────────────────────────────────────
  const crm_merge_entities = {
    name: "crm_merge_entities",
    label: "CRM: Merge Entities",
    description:
      "Merge duplicate entities into one primary entity. Secondary entities are archived; their edges are repointed to primary.",
    parameters: Type.Object({
      primaryId: Type.String({ description: "UUID of the entity to keep" }),
      secondaryId: Type.String({
        description: "UUID of the duplicate to merge and archive",
      }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const primaryId = params.primaryId as string;
      const secondaryId = params.secondaryId as string;
      try {
        const { data, error } = await supabase.rpc("merge_entities", {
          p_primary_id: primaryId,
          p_secondary_id: secondaryId,
          p_merged_metadata: null,
        });
        if (error) {
          return errorResult(error.message);
        }
        const edgesRepointed = data?.[0]?.edges_repointed ?? 0;
        return textResult(
          `Merged entity ${secondaryId} into ${primaryId}. Edges repointed: ${edgesRepointed}.`,
        );
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  // ── crm_search_properties ────────────────────────────────────────────────
  const crm_search_properties = {
    name: "crm_search_properties",
    label: "CRM: Search Properties",
    description: "Search real-estate property entities by location and filters.",
    parameters: Type.Object({
      city: Type.Optional(Type.String({ description: "City" })),
      state: Type.Optional(Type.String({ description: "State abbreviation" })),
      minPrice: Type.Optional(Type.Number({ description: "Minimum price" })),
      maxPrice: Type.Optional(Type.Number({ description: "Maximum price" })),
      minBeds: Type.Optional(Type.Number({ description: "Minimum bedrooms" })),
      maxBeds: Type.Optional(Type.Number({ description: "Maximum bedrooms" })),
      status: Type.Optional(
        Type.String({
          description: 'Listing status ("active", "pending", "sold", "off_market")',
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        // Resolve property type ID
        const { data: propType } = await supabase
          .from("entity_types")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("name", "property")
          .single();
        if (!propType) {
          return errorResult(
            "Property entity type not found. Enable the real-estate module first.",
          );
        }

        const { data, error } = await supabase.rpc("search_properties", {
          p_workspace_id: workspaceId,
          p_type_id: propType.id,
          p_city: (params.city as string) ?? null,
          p_state: (params.state as string) ?? null,
          p_zip: null,
          p_min_price: (params.minPrice as number) ?? null,
          p_max_price: (params.maxPrice as number) ?? null,
          p_min_beds: (params.minBeds as number) ?? null,
          p_max_beds: (params.maxBeds as number) ?? null,
          p_min_baths: null,
          p_max_baths: null,
          p_min_sqft: null,
          p_max_sqft: null,
          p_status: (params.status as string) ?? null,
          p_property_type: null,
          p_mls_number: null,
          p_limit: (params.limit as number) ?? 20,
          p_offset: 0,
        });
        if (error) {
          return errorResult(error.message);
        }
        if (!data?.length) {
          return textResult("No properties found.");
        }
        return textResult(toJson(data));
      } catch (e) {
        return errorResult(String(e));
      }
    },
  };

  return [
    crm_search_entities,
    crm_get_entity,
    crm_create_entity,
    crm_update_entity,
    crm_log_interaction,
    crm_create_edge,
    crm_delete_edge,
    crm_tag_entity,
    crm_find_duplicates,
    crm_merge_entities,
    crm_search_properties,
  ];
}
