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
const CONTEXT_MESSAGE_TYPE = "agent-mail-context-v1";
const CONTEXT_MESSAGE_CONTENT = "Use AgentMail to communicate with other agents.";
const CHECK_INTERVAL_MS = 60_000;
const IDLE_THRESHOLD_MS = 5 * 60_000;
let currentSessionId: string | undefined;
let lastActivityAt = 0;
let agentRunning = false;
let wakeInFlight = false;
let timer: unknown;
let timerContext: SessionContext | undefined;
const wokenMessages = new Set<string>();

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
  if (timer !== undefined && timerContext) timerContext.clearTimer(timer);
  currentSessionId = context.sessionManager.getSessionId();
  lastActivityAt = Date.now();
  agentRunning = false;
  wakeInFlight = false;
  wokenMessages.clear();
  timerContext = context;
  timer = context.setInterval(() => checkForMail(pi), CHECK_INTERVAL_MS);
}

function stopSession(context: SessionContext): void {
  if (timer !== undefined) context.clearTimer(timer);
  timer = undefined;
  timerContext = undefined;
  currentSessionId = undefined;
  lastActivityAt = 0;
  agentRunning = false;
  wakeInFlight = false;
  wokenMessages.clear();
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

function wakeForMessages(pi: ExtensionAPI, messages: UnreadMessage[]): void {
  const fresh = messages.filter((message) => !wokenMessages.has(message.id));
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
    for (const message of fresh) wokenMessages.add(message.id);
    wakeInFlight = true;
  } catch {
    wakeInFlight = false;
  }
}

function checkForMail(pi: ExtensionAPI): void {
  if (!currentSessionId || agentRunning || wakeInFlight) return;
  if (Date.now() - lastActivityAt < IDLE_THRESHOLD_MS) return;
  wakeForMessages(pi, scanUnread(currentSessionId));
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
      env: { AGENT_MAIL_ID: currentSessionId, ...callerEnv },
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
  pi.on("session_fork", (_event, context) => ensureContextMessage(context, pi));
  pi.on("session_shutdown", (_event, context) => stopSession(context));
  pi.on("input", () => {
    lastActivityAt = Date.now();
  });
  pi.on("agent_start", () => {
    agentRunning = true;
    wakeInFlight = false;
    lastActivityAt = Date.now();
  });
  pi.on("agent_end", () => {
    agentRunning = false;
    lastActivityAt = Date.now();
  });
  pi.on("tool_call", (event) => {
    agentRunning = true;
    lastActivityAt = Date.now();
    return injectIdentityForMail(event);
  });
}
