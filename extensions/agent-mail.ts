import { execFileSync } from "node:child_process";

import {
  createHostAdapter,
  type ExtensionAPI,
  type HostAdapter,
  type SessionContext,
} from "./lib/host.ts";

type UnreadMessage = {
  id: string;
  from: string;
  subject: string;
};

const CHECK_INTERVAL_MS = 60_000;
const IDLE_THRESHOLD_MS = 5 * 60_000;

type SessionState = {
  sessionId: string;
  context: SessionContext;
  lastActivityAt: number;
  agentRunning: boolean;
  wakeInFlight: boolean;
  stopTimer?: () => void;
  wokenMessages: Set<string>;
};

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
  if (!state.context.isIdle() || state.context.hasPendingMessages()) return;
  if (Date.now() - state.lastActivityAt < IDLE_THRESHOLD_MS) return;
  wakeForMessages(pi, state, scanUnread(state.sessionId));
}

export default function agentMailExtension(pi: ExtensionAPI): void {
  let host: HostAdapter | undefined;
  let active: SessionState | undefined;

  function stopSession(): void {
    const previous = active;
    active = undefined;
    previous?.stopTimer?.();
  }

  function sessionState(context: SessionContext): SessionState | undefined {
    return active?.sessionId === context.sessionManager.getSessionId() ? active : undefined;
  }

  function refreshSession(context: SessionContext): void {
    if (!host) {
      host = createHostAdapter(context);
      host.onSessionChange(pi, refreshSession);
    }
    stopSession();
    const sessionId = context.sessionManager.getSessionId();
    if (!sessionId) return;

    const state: SessionState = {
      sessionId,
      context,
      lastActivityAt: Date.now(),
      agentRunning: false,
      wakeInFlight: false,
      wokenMessages: new Set<string>(),
    };
    active = state;
    state.stopTimer = host.startTimer(context, () => {
      if (active === state) checkForMail(pi, state);
    }, CHECK_INTERVAL_MS);
  }

  pi.on("session_start", (_event, context) => refreshSession(context));
  pi.on("session_shutdown", () => stopSession());
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
    return (host ?? createHostAdapter(context)).injectIdentity(
      event,
      context.sessionManager.getSessionId(),
    );
  });
}
