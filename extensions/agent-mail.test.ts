import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import agentMailExtension from "./agent-mail.ts";
import { createHostAdapter, type ExtensionAPI, type SessionContext } from "./lib/host.ts";

const MINUTE = 60_000;
const ENV_KEYS = ["PATH", "AGENT_MAIL_ID", "AGENT_MAIL_TEST_OUTPUT", "AGENT_MAIL_TEST_SCAN", "AI_AGENT", "PI_CODING_AGENT"];
let savedEnv: Record<string, string | undefined>;
let root: string;
let timers: TestTimer[];

type TestTimer = { callback: () => void; delay: number; cleared: boolean };

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), "agent-mail-omp-"));
  process.env.PATH = `${root}:/usr/bin:/bin`;
  delete process.env.AGENT_MAIL_ID;
  process.env.AGENT_MAIL_TEST_OUTPUT = join(root, "unread");
  process.env.AGENT_MAIL_TEST_SCAN = join(root, "scans");
  writeFileSync(join(root, "agent-mail"), `#!/bin/sh
if [ "$1" = scan ]; then
  printf '%s\\n' "$3" >> "$AGENT_MAIL_TEST_SCAN"
  /bin/cat "$AGENT_MAIL_TEST_OUTPUT"
else
  printf '%s\\n' "\${AGENT_MAIL_ID-unset}"
fi
`, { mode: 0o755 });
  unread("message-one");
  timers = [];
  setSystemTime(new Date(0));
});

afterEach(() => {
  setSystemTime();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});

function unread(id: string): void {
  writeFileSync(join(root, "unread"), `/inbox\t${id}\tfrom:sender\tA subject\n`);
}

function tick(ms: number): void {
  setSystemTime(new Date(Date.now() + ms));
  for (const timer of timers) if (!timer.cleared) timer.callback();
}

function harness(sessionId = "omp-session") {
  const handlers = new Map<string, Parameters<ExtensionAPI["on"]>[1]>();
  const sent: Array<Parameters<ExtensionAPI["sendMessage"]>> = [];
  const clearedTimers: unknown[] = [];
  const state = { idle: true, pending: false, failSend: false };
  let context: SessionContext = {
    sessionManager: { getSessionId: () => sessionId },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    setInterval(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      (timer as TestTimer).cleared = true;
      clearedTimers.push(timer);
    },
  };
  const api: ExtensionAPI = {
    on(event, handler) { handlers.set(event, handler); },
    sendMessage(...args) {
      if (state.failSend) throw new Error("not ready");
      sent.push(args);
    },
  };
  agentMailExtension(api);
  return {
    handlers, sent, state, clearedTimers,
    get context() { return context; },
    emit(event: string, input: unknown = {}) {
      return handlers.get(event)?.(input, context);
    },
    replaceSession(id: string) {
      context = { ...context, sessionManager: { getSessionId: () => id } };
    },
  };
}

function injected(h: ReturnType<typeof harness>, command = "agent-mail send"): string {
  const event = { toolName: "bash", input: { command, timeout: 10 } };
  const result = h.emit("tool_call", event);
  expect(result?.input).toBe(event.input);
  expect(result?.input.timeout).toBe(10);
  expect(result?.input.env).toBeUndefined();
  return result?.input.command as string;
}

test("OMP detects managed timers from capabilities and never uses raw timers", () => {
  process.env.AI_AGENT = "pi";
  process.env.PI_CODING_AGENT = "true";
  const h = harness();
  expect(createHostAdapter(h.context).kind).toBe("omp");
  const rawTimer = spyOn(globalThis, "setInterval");
  try {
    h.emit("session_start");
    expect(rawTimer).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(MINUTE);
    expect(h.handlers.has("session_switch")).toBe(true);
    expect(h.handlers.has("session_fork")).toBe(false);
    h.emit("session_shutdown");
    h.emit("session_shutdown");
    expect(h.clearedTimers).toEqual([timers[0]]);
    tick(10 * MINUTE);
    expect(h.sent).toHaveLength(0);
  } finally {
    rawTimer.mockRestore();
  }
});

test("OMP returns a replacement Bash input and scopes sender identity to the call", () => {
  const h = harness("omp-session'; printf unsafe; #");
  h.emit("session_start");
  const command = injected(h);
  const output = execFileSync("/bin/bash", ["-c", `${command}\nprintf '%s\\n' "\${AGENT_MAIL_ID-unset}"`], { encoding: "utf8", env: { ...process.env } });
  expect(output).toBe("omp-session'; printf unsafe; #\nunset\n");
  expect(process.env.AGENT_MAIL_ID).toBeUndefined();
});

test("OMP composes input rewrites with other hooks in either order", () => {
  const h = harness();
  h.emit("session_start");
  for (const mailFirst of [true, false]) {
    const event = {
      toolName: "bash",
      input: { command: 'agent-mail send; printf "%s\\n" "$AGENT_MAIL_TEST_PEER"', timeout: 10 },
    };
    const mail = () => h.emit("tool_call", event);
    const peer = () => {
      event.input.command = `export AGENT_MAIL_TEST_PEER='peer';\n${event.input.command}`;
      return { input: event.input };
    };
    let executionInput: Record<string, unknown> | undefined;
    // Match OMP's runner: every hook sees the same event, last replacement wins.
    for (const handler of mailFirst ? [mail, peer] : [peer, mail]) {
      const result = handler();
      if (result?.input) executionInput = result.input;
    }
    expect(executionInput).toBe(event.input);
    expect(executionInput?.timeout).toBe(10);
    const output = execFileSync("/bin/bash", ["-c", executionInput?.command as string], { encoding: "utf8", env: { ...process.env } });
    expect(output).toBe("omp-session\npeer\n");
  }
});

test("OMP preserves inherited, empty, inline, and shell-local sender overrides", () => {
  const h = harness();
  h.emit("session_start");
  const run = (command: string) => execFileSync("/bin/bash", ["-c", injected(h, command)], { encoding: "utf8", env: { ...process.env } });
  process.env.AGENT_MAIL_ID = "inherited sender";
  expect(run("agent-mail send")).toBe("inherited sender\n");
  expect(run("AGENT_MAIL_ID='inline sender' agent-mail send")).toBe("inline sender\n");
  process.env.AGENT_MAIL_ID = "";
  expect(run("agent-mail send")).toBe("\n");
  delete process.env.AGENT_MAIL_ID;
  const command = `AGENT_MAIL_ID='shell-local sender'\n${injected(h)}`;
  expect(execFileSync("/bin/bash", ["-c", command], { encoding: "utf8", env: { ...process.env } })).toBe("shell-local sender\n");
});

test("OMP handles absolute paths, compound and multiline commands without changing exit status", () => {
  const h = harness();
  h.emit("session_start");
  for (const command of [
    `${root}/agent-mail send`,
    "true && agent-mail send # trailing comment",
    "true\nagent-mail send",
    "printf unused | agent-mail send",
  ]) {
    expect(execFileSync("/bin/bash", ["-c", injected(h, command)], { encoding: "utf8", env: { ...process.env } })).toBe("omp-session\n");
  }
  const result = spawnSync("/bin/bash", ["-c", injected(h, "agent-mail send; exit 7")], { env: { ...process.env } });
  expect(result.status).toBe(7);
});

test("OMP leaves unrelated tools, commands, and malformed calls unchanged", () => {
  const h = harness();
  h.emit("session_start");
  for (const event of [
    { toolName: "bash", input: { command: "echo agent-mail" } },
    { toolName: "bash", input: { command: "agent-mailbox send" } },
    { toolName: "read", input: { path: "agent-mail" } },
    { toolName: "bash", input: { command: 42 } },
    null,
  ]) {
    const before = structuredClone(event);
    expect(h.emit("tool_call", event)).toBeUndefined();
    expect(event).toEqual(before);
  }
});

test("OMP waits for inactivity, suppresses repeat wakeups, and wakes for fresh headers", () => {
  const h = harness();
  h.emit("session_start");
  tick(4 * MINUTE);
  expect(h.sent).toHaveLength(0);
  h.emit("input");
  tick(4 * MINUTE);
  expect(h.sent).toHaveLength(0);
  tick(MINUTE);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0][0].content).toMatch(/from sender.*A subject.*message-one/);
  expect(h.sent[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  tick(5 * MINUTE);
  expect(h.sent).toHaveLength(1);
  h.emit("agent_start");
  h.emit("agent_end");
  tick(5 * MINUTE);
  expect(h.sent).toHaveLength(1);
  unread("message-two");
  tick(MINUTE);
  expect(h.sent).toHaveLength(2);
});

test("OMP does not wake during agent work, recovery, or queued input", () => {
  const h = harness();
  h.emit("session_start");
  h.emit("agent_start");
  tick(5 * MINUTE);
  expect(h.sent).toHaveLength(0);
  h.emit("agent_end");
  h.state.idle = false;
  tick(5 * MINUTE);
  expect(h.sent).toHaveLength(0);
  h.state.idle = true;
  h.state.pending = true;
  tick(MINUTE);
  expect(h.sent).toHaveLength(0);
  h.state.pending = false;
  tick(MINUTE);
  expect(h.sent).toHaveLength(1);
});

test("OMP tool activity resets the idle window and failed notifications can retry", () => {
  const h = harness();
  h.emit("session_start");
  tick(4 * MINUTE);
  h.emit("tool_call", { toolName: "read", input: { path: "README.md" } });
  tick(5 * MINUTE);
  expect(h.sent).toHaveLength(0);
  h.emit("agent_end");
  tick(4 * MINUTE);
  expect(h.sent).toHaveLength(0);
  h.state.failSend = true;
  tick(MINUTE);
  expect(h.sent).toHaveLength(0);
  h.state.failSend = false;
  tick(MINUTE);
  expect(h.sent).toHaveLength(1);
});

test("OMP switches including forks cancel old timers and reset wakeup state", () => {
  const h = harness();
  h.emit("session_start");
  for (const reason of ["new", "resume", "fork"]) {
    const oldTimer = timers.at(-1)!;
    h.replaceSession(`omp-${reason}`);
    h.emit("session_switch", { reason });
    expect(oldTimer.cleared).toBe(true);
    oldTimer.callback(); // Even an already-queued stale callback must not scan.
    tick(5 * MINUTE);
    expect(readFileSync(join(root, "scans"), "utf8").trim().split("\n").at(-1)).toBe(`omp-${reason}`);
  }
  expect(h.sent).toHaveLength(3);
  expect(readFileSync(join(root, "scans"), "utf8").trim().split("\n")).toEqual(["omp-new", "omp-resume", "omp-fork"]);
  h.emit("session_shutdown");
  expect(timers.every((timer) => timer.cleared)).toBe(true);
});

test("OMP repeated starts cancel old timers even without an intervening shutdown", () => {
  const h = harness();
  h.emit("session_start");
  h.replaceSession("replacement");
  h.emit("session_start");
  expect(timers[0].cleared).toBe(true);
  tick(5 * MINUTE);
  expect(h.sent).toHaveLength(1);
  expect(readFileSync(join(root, "scans"), "utf8")).toBe("replacement\n");
});

test("OMP extension instances do not share state even for the same session ID", () => {
  const first = harness();
  const second = harness();
  first.emit("session_start");
  second.emit("session_start");
  first.emit("session_shutdown");
  tick(5 * MINUTE);
  expect(first.sent).toHaveLength(0);
  expect(second.sent).toHaveLength(1);
});

test("OMP does not start monitoring or inject identity without a session ID", () => {
  const h = harness("");
  h.emit("session_start");
  expect(h.emit("tool_call", { toolName: "bash", input: { command: "agent-mail send" } })).toBeUndefined();
  expect(timers).toHaveLength(0);
  tick(5 * MINUTE);
  expect(h.sent).toHaveLength(0);
});
