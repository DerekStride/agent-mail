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

const AGENT_MAIL_COMMAND =
  /(?:^|[;&|]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*)(?:\S*\/)?agent-mail(?=\s|$)/;
let currentSessionId: string | undefined;

function refreshSession(context: SessionContext): void {
  currentSessionId = context.sessionManager.getSessionId();
}

function mailEnvironment(sessionId: string): Record<string, string> {
  return { AGENT_MAIL_ID: sessionId };
}

function injectIdentityForMail(
  event: unknown,
): { input: Record<string, unknown> } | undefined {
  if (!currentSessionId || typeof event !== "object" || event === null) return;
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
      env: { ...mailEnvironment(currentSessionId), ...callerEnv },
    },
  };
}

export default function agentMailExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => refreshSession(context));
  pi.on("session_switch", (_event, context) => refreshSession(context));
  pi.on("agent_start", (_event, context) => refreshSession(context));
  pi.on("tool_call", injectIdentityForMail);
}
