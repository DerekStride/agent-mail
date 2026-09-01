import { expect, test } from "bun:test";

import agentMailExtension from "./agent-mail";

type TestTimer = {
  callback: () => void;
  delay: number;
};

type TestContext = {
  sessionManager: {
    getSessionId(): string;
    getBranch(): unknown[];
  };
  setInterval(callback: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
  timers: TestTimer[];
  clearedTimers: unknown[];
};

type Handler = (event: unknown, context: TestContext) => unknown;

function context(sessionId: string): TestContext {
  const timers: TestTimer[] = [];
  const clearedTimers: unknown[] = [];
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
    setInterval(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      clearedTimers.push(timer);
    },
    timers,
    clearedTimers,
  };
}

test("session identity and wake timers stay isolated", () => {
  const handlers: Record<string, Handler> = {};
  const api = {
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    },
    sendMessage() {},
  };
  agentMailExtension(api as never);

  const parent = context("parent-session");
  const child = context("child-session");
  handlers.session_start?.({}, parent);
  handlers.session_fork?.({}, child);
  expect(parent.timers).toHaveLength(1);
  expect(child.timers).toHaveLength(1);
  expect(parent.clearedTimers).toEqual([]);
  const command = "agent-mail send --to receiver --body hello";
  const event = {
    toolName: "bash",
    input: {
      command,
      env: { AGENT_MAIL_ROOT: "/tmp/test-mail" },
    },
  };
  const expected = {
    input: {
      command,
      env: {
        AGENT_MAIL_ID: "parent-session",
        AGENT_MAIL_ROOT: "/tmp/test-mail",
      },
    },
  };

  expect(handlers.tool_call?.(event, parent)).toEqual(expected);
  handlers.session_shutdown?.({}, child);
  expect(child.clearedTimers).toEqual([child.timers[0]]);
  expect(parent.clearedTimers).toEqual([]);
  expect(handlers.tool_call?.(event, parent)).toEqual(expected);

  handlers.session_shutdown?.({}, parent);
  expect(parent.clearedTimers).toEqual([parent.timers[0]]);
});
