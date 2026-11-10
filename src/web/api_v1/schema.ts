// The v1 schema is served directly and snapshotted by the contract test.
import { Type, type Static } from "typebox";

export const API_MAJOR = 1;
export const API_REVISION = 7;

const TagSchema = Type.Object({
  at: Type.Number(),
  by: Type.String(),
  until: Type.Optional(Type.Number()),
});

const status = Type.Union([
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("stopping"),
  Type.Literal("interrupted"),
  Type.Literal("error"),
  Type.Literal("deleting"),
  Type.Literal("unknown"),
]);
export const AgentSchema = Type.Object({
  id: Type.String(),
  parent: Type.Union([Type.String(), Type.Null()]),
  title: Type.String(),
  status,
  status_reason: Type.Union([Type.String(), Type.Null()]),
  queued: Type.Integer({ minimum: 0 }),
  background_shells: Type.Integer({ minimum: 0 }),
  monitor_shells: Type.Integer({ minimum: 0 }),
  taken_over: Type.Boolean(),
  side_of: Type.Optional(Type.String()),
  workdir: Type.Union([Type.String(), Type.Null()], {
    description:
      "Configured initial work directory; not the current chdir directory.",
  }),
  updated: Type.Number(),
  tags: Type.Optional(Type.Record(Type.String(), TagSchema)),
  operator_message_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  replied_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});
export type Agent = Static<typeof AgentSchema>;
export const AgentStatusSchema = Type.Object({
  ...AgentSchema.properties,
  context: Type.Union(
    [
      Type.Object({
        tokens: Type.Integer({ minimum: 0 }),
        window: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
        session: Type.Optional(
          Type.String({
            description: "History identity matching /view session.",
          }),
        ),
      }),
      Type.Null(),
    ],
    {
      description:
        "Last measured prompt usage committed while live; null when cold or unknown. No store is opened by status reads.",
    },
  ),
});
export type AgentStatus = Static<typeof AgentStatusSchema>;
export const ShellSchema = Type.Object({
  id: Type.String(),
  mode: Type.Union([Type.Literal("background"), Type.Literal("monitor")]),
  command: Type.String(),
  elapsed_seconds: Type.Number({ minimum: 0 }),
});
export const MessageSchema = Type.Object({
  cursor: Type.Integer({ minimum: 0 }),
  at: Type.Union([Type.Number(), Type.Null()]),
  kind: Type.Union([
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("tool_call"),
    Type.Literal("tool_result"),
  ]),
  text: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String()),
  args: Type.Optional(Type.String()),
  truncated: Type.Optional(Type.Boolean()),
});
export const ErrorSchema = Type.Object({
  detail: Type.String(),
  code: Type.Union([
    Type.Literal("not_found"),
    Type.Literal("invalid_request"),
    Type.Literal("forbidden"),
    Type.Literal("unauthorized"),
    Type.Literal("not_ready"),
    Type.Literal("conflict"),
    Type.Literal("too_large"),
  ]),
});
export const apiSchema = {
  api: API_MAJOR,
  revision: API_REVISION,
  routes: {
    "GET /api/v1/version": {
      response: Type.Object({
        api: Type.Literal(API_MAJOR),
        revision: Type.Integer(),
        release: Type.String(),
        display_name: Type.String(),
      }),
    },
    "GET /api/v1/schema": { response: { type: "object" } },
    "POST /api/v1/agents/tags": {
      request: Type.Object({
        ids: Type.Array(Type.String(), { minItems: 1, maxItems: 500 }),
        set: Type.Record(
          Type.String(),
          Type.Union([Type.Number(), Type.Null()]),
        ),
        clear: Type.Array(Type.String()),
      }),
      response: Type.Object({ missing: Type.Array(Type.String()) }),
    },
    "GET /api/v1/agents": {
      query: Type.Object({ root: Type.Optional(Type.String()) }),
      response: Type.Object({ agents: Type.Array(AgentStatusSchema) }),
    },
    "GET /api/v1/agents/{id}": {
      response: Type.Intersect([
        AgentStatusSchema,
        Type.Object({ shells: Type.Array(ShellSchema) }),
      ]),
    },
    "POST /api/v1/agents/{id}/compact": {
      response: Type.Object({
        id: Type.String(),
        action: Type.Literal("compact"),
        queued: Type.Boolean(),
      }),
    },
    "GET /api/v1/agents/{id}/messages": {
      query: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        before: Type.Optional(Type.Integer({ minimum: 0 })),
        after: Type.Optional(Type.Integer({ minimum: 0 })),
        full: Type.Optional(Type.Boolean()),
      }),
      response: Type.Object({
        messages: Type.Array(MessageSchema),
        prev: Type.Integer(),
        next: Type.Integer(),
      }),
    },
    "POST /api/v1/agents/{id}/messages": {
      request: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 32768 }),
        interrupt: Type.Optional(Type.Boolean()),
        client_message_id: Type.Optional(
          Type.String({ pattern: "^[A-Za-z0-9._-]{1,64}$" }),
        ),
      }),
      response: Type.Object({
        message_id: Type.String(),
        status,
        steer: Type.Boolean(),
        interrupted: Type.Optional(Type.Boolean()),
      }),
    },
    "GET /api/v1/agents/{id}/idle": {
      response: Type.Object({
        idle: Type.Boolean(),
        busy: Type.Array(
          Type.Object({
            id: Type.String(),
            reason: Type.Union([
              Type.Literal("running"),
              Type.Literal("stopping"),
              Type.Literal("queued"),
              Type.Literal("shell"),
            ]),
          }),
        ),
      }),
    },
  },
  error: ErrorSchema,
};
