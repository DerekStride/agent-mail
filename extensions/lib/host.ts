// Structural host contracts: keep OMP-only APIs optional and confined to this adapter.
export type SessionContext = {
  sessionManager: {
    getSessionId(): string | undefined;
  };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  setInterval?(callback: () => void, delay: number): unknown;
  clearTimer?(timer: unknown): void;
};

type ToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

type InputReplacement = { input: Record<string, unknown> };
type Handler = (event: unknown, context: SessionContext) => InputReplacement | void;

export type ExtensionAPI = {
  on(
    event:
      | "session_start"
      | "session_switch"
      | "session_shutdown"
      | "input"
      | "agent_start"
      | "agent_end"
      | "tool_call",
    handler: Handler,
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

export type HostAdapter = {
  kind: "omp" | "pi";
  onSessionChange(api: ExtensionAPI, refresh: (context: SessionContext) => void): void;
  startTimer(context: SessionContext, callback: () => void, delay: number): () => void;
  injectIdentity(event: unknown, sessionId: string | undefined): InputReplacement | void;
};

const AGENT_MAIL_COMMAND =
  /(?:^|[;&|\n])\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*)(?:\S*\/)?agent-mail(?=\s|$)/;

function mailInput(event: unknown): ToolCallEvent | undefined {
  if (typeof event !== "object" || event === null) return;
  const call = event as Partial<ToolCallEvent>;
  if (call.toolName !== "bash" || !call.input) return;
  const command = call.input.command;
  if (typeof command !== "string" || !AGENT_MAIL_COMMAND.test(command)) return;
  return call as ToolCallEvent;
}

function withIdentity(command: string, sessionId: string): string {
  const quotedId = `'${sessionId.replaceAll("'", "'\\''")}'`;
  // Neither host's Bash tool consumes input.env. Scope the default to this call,
  // including on OMP's persistent shell, and preserve inherited/inline overrides.
  return [
    "(",
    `if [ "\${AGENT_MAIL_ID+x}" != x ]; then AGENT_MAIL_ID=${quotedId}; fi`,
    "export AGENT_MAIL_ID",
    command,
    ")",
  ].join("\n");
}

export function createHostAdapter(context: SessionContext): HostAdapter {
  // Detect capabilities, not process.env: OMP launched by Pi can inherit PI_*.
  const managedTimers =
    typeof context.setInterval === "function" && typeof context.clearTimer === "function";

  if (managedTimers) {
    return {
      kind: "omp",
      onSessionChange(api, refresh) {
        // OMP uses this event for new, resume, and fork; Pi restarts the runtime.
        api.on("session_switch", (_event, ctx) => refresh(ctx));
      },
      startTimer(ctx, callback, delay) {
        const timer = ctx.setInterval!(callback, delay);
        return () => ctx.clearTimer!(timer);
      },
      injectIdentity(event, sessionId) {
        if (!sessionId) return;
        const call = mailInput(event);
        if (!call) return;
        // OMP passes the same event to every hook, but only the last returned
        // input wins. Mutate it too so later hooks preserve this rewrite.
        call.input.command = withIdentity(call.input.command as string, sessionId);
        return { input: call.input };
      },
    };
  }

  return {
    kind: "pi",
    onSessionChange() {
      // session_shutdown/session_start cover new, resume, fork, and reload.
    },
    startTimer(_ctx, callback, delay) {
      const timer = setInterval(() => {
        try {
          callback();
        } catch (error) {
          // OMP's managed timers contain callback errors; do not let Pi's raw
          // timer turn a background inbox failure into a process crash either.
          console.error("agent-mail: inbox check failed", error);
        }
      }, delay);
      timer.unref();
      return () => clearInterval(timer);
    },
    injectIdentity(event, sessionId) {
      if (!sessionId) return;
      const call = mailInput(event);
      if (!call) return;
      // Pi ignores returned input replacements; mutate the original object.
      call.input.command = withIdentity(call.input.command as string, sessionId);
    },
  };
}
