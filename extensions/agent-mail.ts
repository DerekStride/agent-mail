import { execFileSync } from "node:child_process";

type SessionContext = {
  sessionManager: {
    getSessionId(): string | undefined;
  };
};

type ToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

type ExtensionAPI = {
  on(
    event: "session_start" | "session_switch" | "agent_start" | "tool_call",
    handler: (event: unknown, context: SessionContext) => unknown,
  ): void;
};

type Assignment = {
  session_id: string;
  name: string;
  slug: string;
  first_name: string;
  family_name: string;
  realm: string;
};

const AGENT_MAIL_COMMAND =
  /(?:^|[;&|]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*)(?:\S*\/)?agent-mail(?=\s|$)/;
let currentAssignment: Assignment | undefined;

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`agent-id JSON field ${key} is missing or invalid`);
  }
  return result;
}

function parseAssignment(output: string): Assignment {
  const value: unknown = JSON.parse(output);
  if (typeof value !== "object" || value === null) {
    throw new Error("agent-id JSON output is not an object");
  }
  const record = value as Record<string, unknown>;
  return {
    session_id: requiredString(record, "session_id"),
    name: requiredString(record, "name"),
    slug: requiredString(record, "slug"),
    first_name: requiredString(record, "first_name"),
    family_name: requiredString(record, "family_name"),
    realm: requiredString(record, "realm"),
  };
}

function lookupAssignment(sessionId: string): Assignment | undefined {
  try {
    const output = execFileSync(
      "agent-id",
      ["lookup", "--session-id", sessionId, "--json"],
      { encoding: "utf8", timeout: 5000 },
    );
    return parseAssignment(output);
  } catch {
    // agent-id is optional. agent-mail continues to work with session IDs.
    return undefined;
  }
}

function environmentAssignment(sessionId: string): Assignment | undefined {
  if (process.env.AGENT_ID_SESSION_ID !== sessionId) return;

  try {
    const environment = process.env as Record<string, unknown>;
    return {
      session_id: requiredString(environment, "AGENT_ID_SESSION_ID"),
      name: requiredString(environment, "AGENT_ID_NAME"),
      slug: requiredString(environment, "AGENT_ID_SLUG"),
      first_name: requiredString(environment, "AGENT_ID_FIRST_NAME"),
      family_name: requiredString(environment, "AGENT_ID_FAMILY_NAME"),
      realm: requiredString(environment, "AGENT_ID_REALM"),
    };
  } catch {
    return undefined;
  }
}

function refreshIdentity(context: SessionContext): void {
  currentAssignment = undefined;
  const sessionId = context.sessionManager.getSessionId();
  if (!sessionId) return;
  currentAssignment = environmentAssignment(sessionId) ?? lookupAssignment(sessionId);
}

function identityEnvironment(assignment: Assignment): Record<string, string> {
  return {
    AGENT_ID_SESSION_ID: assignment.session_id,
    AGENT_ID_NAME: assignment.name,
    AGENT_ID_SLUG: assignment.slug,
    AGENT_ID_FIRST_NAME: assignment.first_name,
    AGENT_ID_FAMILY_NAME: assignment.family_name,
    AGENT_ID_REALM: assignment.realm,
  };
}

function injectIdentityForMail(
  event: unknown,
): { input: Record<string, unknown> } | undefined {
  if (!currentAssignment || typeof event !== "object" || event === null) return;
  const toolEvent = event as Partial<ToolCallEvent>;
  if (toolEvent.toolName !== "bash" || !toolEvent.input) return;

  const command = toolEvent.input.command;
  if (typeof command !== "string" || !AGENT_MAIL_COMMAND.test(command)) return;

  const existingEnv = toolEvent.input.env;
  const callerEnv =
    typeof existingEnv === "object" && existingEnv !== null && !Array.isArray(existingEnv)
      ? (existingEnv as Record<string, unknown>)
      : {};
  return {
    input: {
      ...toolEvent.input,
      env: { ...identityEnvironment(currentAssignment), ...callerEnv },
    },
  };
}

export default function agentMailExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => refreshIdentity(context));
  pi.on("session_switch", (_event, context) => refreshIdentity(context));
  pi.on("agent_start", (_event, context) => refreshIdentity(context));
  pi.on("tool_call", injectIdentityForMail);
}
