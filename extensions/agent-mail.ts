import { execFileSync } from "node:child_process";

type SessionContext = {
  sessionManager: {
    getSessionId(): string | undefined;
    getBranch(): unknown[];
  };
  setInterval(callback: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
};

type ToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

type ExtensionAPI = {
  on(
    event:
      | "session_start"
      | "session_switch"
      | "session_fork"
      | "session_shutdown"
      | "input"
      | "agent_start"
      | "agent_end"
      | "tool_call",
    handler: (event: unknown, context: SessionContext) => unknown,
  ): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
    },
    options?: { deliverAs: "followUp"; triggerTurn: boolean },
  ): void;
};

type UnreadMessage = {
  id: string;
  from: string;
  subject: string;
};

const AGENT_MAIL_COMMAND =
  /(?:^|[;&|]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*)(?:\S*\/)?agent-mail(?=\s|$)/;
const CONTEXT_MESSAGE_TYPE = "agent-mail-context-v2";
const CONTEXT_MESSAGE_CONTENT =
  "Use AgentMail to communicate with other agents. Run `agent-mail prime` to learn how to use it.";
const CHECK_INTERVAL_MS = 60_000;
const IDLE_THRESHOLD_MS = 5 * 60_000;

type SessionState = {
  sessionId: string;
  context: SessionContext;
  lastActivityAt: number;
  agentRunning: boolean;
  wakeInFlight: boolean;
  timer?: unknown;
  wokenMessages: Set<string>;
};

const sessions = new Map<string, SessionState>();

function branchHasContextMessage(entries: unknown[]): boolean {
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as { type?: unknown; customType?: unknown };
    return candidate.type === "custom_message" && candidate.customType === CONTEXT_MESSAGE_TYPE;
  });
}

function ensureContextMessage(context: SessionContext, pi: ExtensionAPI): void {
  if (branchHasContextMessage(context.sessionManager.getBranch())) return;
  pi.sendMessage({
    customType: CONTEXT_MESSAGE_TYPE,
    content: CONTEXT_MESSAGE_CONTENT,
    display: false,
  });
}

function refreshSession(context: SessionContext, pi: ExtensionAPI): void {
  const sessionId = context.sessionManager.getSessionId();
  if (!sessionId) return;

  const previous = sessions.get(sessionId);
  if (previous?.timer !== undefined) previous.context.clearTimer(previous.timer);

  const state: SessionState = {
    sessionId,
    context,
    lastActivityAt: Date.now(),
    agentRunning: false,
    wakeInFlight: false,
    wokenMessages: new Set<string>(),
  };
  sessions.set(sessionId, state);
  state.timer = context.setInterval(() => checkForMail(pi, state), CHECK_INTERVAL_MS);
}

function stopSession(context: SessionContext): void {
  const sessionId = context.sessionManager.getSessionId();
  if (!sessionId) return;

  const state = sessions.get(sessionId);
  if (!state) return;
  if (state.timer !== undefined) state.context.clearTimer(state.timer);
  sessions.delete(sessionId);
}

function sessionState(context: SessionContext): SessionState | undefined {
  const sessionId = context.sessionManager.getSessionId();
  return sessionId ? sessions.get(sessionId) : undefined;
}

function scanUnread(sessionId: string): UnreadMessage[] {
  try {
    const output = execFileSync("agent-mail", ["scan", "--to", sessionId], {
      env: { ...process.env, AGENT_MAIL_ID: sessionId },
      encoding: "utf8",
      timeout: 5000,
    });
    return output
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("("))
      .flatMap((line) => {
        const columns = line.split("\t");
        if (columns.length < 4 || !columns[1]) return [];
        return [
          {
            id: columns[1],
            from: columns[2]?.replace(/^from:/, "") || "unknown",
            subject: columns.slice(3).join("\t") || "(no subject)",
          },
        ];
      });
  } catch {
    return [];
  }
}

function wakeForMessages(
  pi: ExtensionAPI,
  state: SessionState,
  messages: UnreadMessage[],
): void {
  const fresh = messages.filter((message) => !state.wokenMessages.has(message.id));
  if (fresh.length === 0) return;

  const lines = fresh.map(
    (message) =>
      `- from ${message.from} · "${message.subject}" · id ${message.id}`,
  );
  try {
    pi.sendMessage(
      {
        customType: "agent-mail",
        content: [
          `agent-mail — ${fresh.length} unread message${fresh.length === 1 ? "" : "s"}:`,
          lines.join("\n"),
          "Read with `agent-mail read <MSGID>`; reply or discard only when useful.",
          "This follow-up was triggered after five minutes without user input.",
        ].join("\n"),
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    for (const message of fresh) state.wokenMessages.add(message.id);
    state.wakeInFlight = true;
  } catch {
    state.wakeInFlight = false;
  }
}

function checkForMail(pi: ExtensionAPI, state: SessionState): void {
  if (state.agentRunning || state.wakeInFlight) return;
  if (Date.now() - state.lastActivityAt < IDLE_THRESHOLD_MS) return;
  wakeForMessages(pi, state, scanUnread(state.sessionId));
}

function injectIdentityForMail(
  event: unknown,
  sessionId: string | undefined,
): { input: Record<string, unknown> } | undefined {
  if (!sessionId || typeof event !== "object" || event === null) return;
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
      env: { AGENT_MAIL_ID: sessionId, ...callerEnv },
    },
  };
}

export default function agentMailExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => {
    ensureContextMessage(context, pi);
    refreshSession(context, pi);
  });
  pi.on("session_switch", (_event, context) => {
    ensureContextMessage(context, pi);
    refreshSession(context, pi);
  });
  pi.on("session_fork", (_event, context) => {
    ensureContextMessage(context, pi);
    refreshSession(context, pi);
  });
  pi.on("session_shutdown", (_event, context) => stopSession(context));
  pi.on("input", (_event, context) => {
    const state = sessionState(context);
    if (state) state.lastActivityAt = Date.now();
  });
  pi.on("agent_start", (_event, context) => {
    const state = sessionState(context);
    if (!state) return;
    state.agentRunning = true;
    state.wakeInFlight = false;
    state.lastActivityAt = Date.now();
  });
  pi.on("agent_end", (_event, context) => {
    const state = sessionState(context);
    if (!state) return;
    state.agentRunning = false;
    state.lastActivityAt = Date.now();
  });
  pi.on("tool_call", (event, context) => {
    const state = sessionState(context);
    if (state) {
      state.agentRunning = true;
      state.lastActivityAt = Date.now();
    }
    return injectIdentityForMail(event, context.sessionManager.getSessionId());
  });
}
