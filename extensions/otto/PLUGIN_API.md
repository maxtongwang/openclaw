# OpenClaw Plugin API — Otto Extension Reference

Verified against `/Users/mwang/openclaw/src/plugins/types.ts` on 2026-02-20.

## Verified Method Signatures

| Method              | Signature                                                                                                               | Source       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------ |
| `registerTool`      | `api.registerTool(tool: AnyAgentTool \| OpenClawPluginToolFactory, opts?: OpenClawPluginToolOptions) => void`           | types.ts:243 |
| `on` (hooks)        | `api.on<K extends PluginHookName>(hookName: K, handler: PluginHookHandlerMap[K], opts?: { priority?: number }) => void` | types.ts:267 |
| `registerService`   | `api.registerService(service: OpenClawPluginService) => void`                                                           | types.ts:257 |
| `registerCommand`   | `api.registerCommand(command: OpenClawPluginCommandDefinition) => void`                                                 | types.ts:264 |
| `registerHttpRoute` | `api.registerHttpRoute(params: { path: string; handler: OpenClawPluginHttpRouteHandler }) => void`                      | types.ts:253 |

## Hook Names

```ts
type PluginHookName =
  | "before_agent_start" // pre-turn: inject context, returns { prependContext? }
  | "agent_end"
  | "before_compaction"
  | "after_compaction"
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "before_tool_call" // pre-tool: returns { allow: bool } or void
  | "after_tool_call"
  | "tool_result_persist"
  | "session_start"
  | "session_end"
  | "gateway_start"
  | "gateway_stop";
```

## Key Type Details

### `OpenClawPluginService`

```ts
type OpenClawPluginService = {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
};
```

### `OpenClawPluginCommandDefinition`

```ts
type OpenClawPluginCommandDefinition = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: PluginCommandHandler;
};
```

### `OpenClawPluginApi` (plugin context)

```ts
type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  source: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  registerTool: ...;
  registerHttpRoute: ...;
  registerService: ...;
  registerCommand: ...;
  on: ...;
};
```

## Corrections vs Original Plan

| Plan Assumed                                   | Actual                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `api.registerCommand(name, handler)`           | `api.registerCommand({ name, description, handler, ...})` — object arg |
| `api.registerHttpRoute(method, path, handler)` | `api.registerHttpRoute({ path, handler })` — no `method` param         |
| `api.runtime.cron.createJob(...)`              | **Not available** — cron is an agent tool, not plugin API              |

## Cron Alternative

Cron jobs are registered via the agent's built-in cron tool, not through the plugin API. To schedule recurring work, either:

1. Use `agentTurn` payloads via the existing cron agent tool
2. Register a service (`api.registerService`) with a `setInterval` internally
