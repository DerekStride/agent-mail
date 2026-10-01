import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";

import agentMailExtension from "./agent-mail.ts";
import { createHostAdapter, type ExtensionAPI, type SessionContext } from "./lib/host.ts";

const MINUTE = 60_000;
const PI_EVENTS = new Set([
  "session_start", "session_shutdown", "input", "agent_start", "agent_end", "tool_call",
]);
const ENV_KEYS = ["PATH", "AGENT_MAIL_ID", "AGENT_MAIL_TEST_OUTPUT", "AGENT_MAIL_TEST_SCAN", "AI_AGENT", "PI_CODING_AGENT"];
let savedEnv: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), "agent-mail-pi-"));
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
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});

function unread(id: string): void {
  writeFileSync(join(root, "unread"), `/inbox\t${id}\tfrom:sender\tA subject\n`);
}

function harness(sessionId: string | undefined = "pi-session") {
  const handlers = new Map<string, Parameters<ExtensionAPI["on"]>[1]>();
  const sent: Array<Parameters<ExtensionAPI["sendMessage"]>> = [];
  const state = { idle: true, pending: false, failSend: false };
  let context: SessionContext = {
    sessionManager: { getSessionId: () => sessionId },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
  };
  const api: ExtensionAPI = {
    on(event, handler) {
      assert(PI_EVENTS.has(event), `Unsupported Pi event: ${event}`);
      handlers.set(event, handler);
    },
    sendMessage(...args) {
      if (state.failSend) throw new Error("not ready");
      sent.push(args);
    },
  };
  agentMailExtension(api);
  return {
    handlers, sent, state,
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
  const input = event.input;
  assert.equal(h.emit("tool_call", event), undefined);
  assert.equal(event.input, input);
  assert.equal(event.input.timeout, 10);
  assert.equal("env" in event.input, false);
  return event.input.command;
}

test("Pi detects the host from context capabilities and starts a native timer", () => {
  process.env.AI_AGENT = "omp";
  delete process.env.PI_CODING_AGENT;
  const h = harness();
  assert.equal(createHostAdapter(h.context).kind, "pi");
  const timerSpy = mock.method(globalThis, "setInterval");
  h.emit("session_start", { reason: "startup" });
  assert.equal(timerSpy.mock.callCount(), 1);
  assert.equal(timerSpy.mock.calls[0].arguments[1], MINUTE);
  assert.equal(h.handlers.has("session_switch"), false);
  assert.equal(h.handlers.has("session_fork"), false);
  h.emit("session_shutdown");
  h.emit("session_shutdown");
  mock.timers.tick(10 * MINUTE);
  assert.equal(h.sent.length, 0);
});

test("Pi mutates Bash input in place and scopes sender identity to the call", () => {
  const h = harness("pi-session'; printf unsafe; #");
  h.emit("session_start");
  const command = injected(h);
  const output = execFileSync("/bin/bash", ["-c", `${command}\nprintf '%s\\n' "\${AGENT_MAIL_ID-unset}"`], { encoding: "utf8", env: { ...process.env } });
  assert.equal(output, "pi-session'; printf unsafe; #\nunset\n");
  assert.equal(process.env.AGENT_MAIL_ID, undefined);
});

test("Pi composes input rewrites with other hooks in either order", () => {
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
    };
    for (const handler of mailFirst ? [mail, peer] : [peer, mail]) {
      assert.equal(handler(), undefined);
    }
    assert.equal(event.input.timeout, 10);
    const output = execFileSync("/bin/bash", ["-c", event.input.command], { encoding: "utf8", env: { ...process.env } });
    assert.equal(output, "pi-session\npeer\n");
  }
});

test("Pi preserves inherited, empty, inline, and shell-local sender overrides", () => {
  const h = harness();
  h.emit("session_start");
  const run = (command: string) => execFileSync("/bin/bash", ["-c", injected(h, command)], { encoding: "utf8", env: { ...process.env } });
  process.env.AGENT_MAIL_ID = "inherited sender";
  assert.equal(run("agent-mail send"), "inherited sender\n");
  assert.equal(run("AGENT_MAIL_ID='inline sender' agent-mail send"), "inline sender\n");
  process.env.AGENT_MAIL_ID = "";
  assert.equal(run("agent-mail send"), "\n");
  delete process.env.AGENT_MAIL_ID;
  const command = `AGENT_MAIL_ID='shell-local sender'\n${injected(h)}`;
  assert.equal(execFileSync("/bin/bash", ["-c", command], { encoding: "utf8", env: { ...process.env } }), "shell-local sender\n");
});

test("Pi handles absolute paths, compound and multiline commands without changing exit status", () => {
  const h = harness();
  h.emit("session_start");
  for (const command of [
    `${root}/agent-mail send`,
    "true && agent-mail send # trailing comment",
    "true\nagent-mail send",
    "printf unused | agent-mail send",
  ]) {
    assert.equal(execFileSync("/bin/bash", ["-c", injected(h, command)], { encoding: "utf8", env: { ...process.env } }), "pi-session\n");
  }
  const result = spawnSync("/bin/bash", ["-c", injected(h, "agent-mail send; exit 7")], { env: { ...process.env } });
  assert.equal(result.status, 7);
});

test("Pi leaves unrelated tools, commands, and malformed calls unchanged", () => {
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
    assert.equal(h.emit("tool_call", event), undefined);
    assert.deepEqual(event, before);
  }
});

test("Pi waits for inactivity, suppresses repeat wakeups, and wakes for fresh headers", () => {
  const h = harness();
  h.emit("session_start");
  mock.timers.tick(4 * MINUTE);
  assert.equal(h.sent.length, 0);
  h.emit("input");
  mock.timers.tick(4 * MINUTE);
  assert.equal(h.sent.length, 0);
  mock.timers.tick(MINUTE);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0][0].content, /from sender.*A subject.*message-one/);
  assert.deepEqual(h.sent[0][1], { deliverAs: "followUp", triggerTurn: true });
  mock.timers.tick(5 * MINUTE);
  assert.equal(h.sent.length, 1);
  h.emit("agent_start");
  h.emit("agent_end");
  mock.timers.tick(5 * MINUTE);
  assert.equal(h.sent.length, 1);
  unread("message-two");
  mock.timers.tick(MINUTE);
  assert.equal(h.sent.length, 2);
});

test("Pi does not wake during agent work, recovery, or queued input", () => {
  const h = harness();
  h.emit("session_start");
  h.emit("agent_start");
  mock.timers.tick(5 * MINUTE);
  assert.equal(h.sent.length, 0);
  h.emit("agent_end");
  h.state.idle = false;
  mock.timers.tick(5 * MINUTE);
  assert.equal(h.sent.length, 0);
  h.state.idle = true;
  h.state.pending = true;
  mock.timers.tick(MINUTE);
  assert.equal(h.sent.length, 0);
  h.state.pending = false;
  mock.timers.tick(MINUTE);
  assert.equal(h.sent.length, 1);
});

test("Pi tool activity resets the idle window and failed notifications can retry", () => {
  const h = harness();
  h.emit("session_start");
  mock.timers.tick(4 * MINUTE);
  h.emit("tool_call", { toolName: "read", input: { path: "README.md" } });
  mock.timers.tick(5 * MINUTE);
  assert.equal(h.sent.length, 0);
  h.emit("agent_end");
  mock.timers.tick(4 * MINUTE);
  assert.equal(h.sent.length, 0);
  h.state.failSend = true;
  mock.timers.tick(MINUTE);
  assert.equal(h.sent.length, 0);
  h.state.failSend = false;
  mock.timers.tick(MINUTE);
  assert.equal(h.sent.length, 1);
});

test("Pi replacements and reloads cancel old timers and reset wakeup state", () => {
  const h = harness();
  for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
    h.replaceSession(`pi-${reason}`);
    h.emit("session_start", { reason });
    mock.timers.tick(5 * MINUTE);
    assert.equal(readFileSync(join(root, "scans"), "utf8").trim().split("\n").at(-1), `pi-${reason}`);
    const count = h.sent.length;
    h.emit("session_shutdown", { reason });
    mock.timers.tick(5 * MINUTE);
    assert.equal(h.sent.length, count);
  }
  assert.equal(h.sent.length, 5);
});

test("Pi repeated starts cancel old timers even without an intervening shutdown", () => {
  const h = harness();
  h.emit("session_start");
  h.replaceSession("replacement");
  h.emit("session_start");
  mock.timers.tick(5 * MINUTE);
  assert.equal(h.sent.length, 1);
  assert.equal(readFileSync(join(root, "scans"), "utf8"), "replacement\n");
});

test("Pi timer callback errors are reported without escaping or stopping cleanup", () => {
  const h = harness();
  const error = new Error("inbox failure");
  const log = mock.method(console, "error", () => {});
  const stop = createHostAdapter(h.context).startTimer(h.context, () => { throw error; }, MINUTE);
  assert.doesNotThrow(() => mock.timers.tick(MINUTE));
  assert.deepEqual(log.mock.calls[0].arguments, ["agent-mail: inbox check failed", error]);
  stop();
  mock.timers.tick(MINUTE);
  assert.equal(log.mock.callCount(), 1);
});

test("Pi extension instances do not share state even for the same session ID", () => {
  const first = harness();
  const second = harness();
  first.emit("session_start");
  second.emit("session_start");
  first.emit("session_shutdown");
  mock.timers.tick(5 * MINUTE);
  assert.equal(first.sent.length, 0);
  assert.equal(second.sent.length, 1);
});

test("Pi does not start monitoring or inject identity without a session ID", () => {
  const h = harness("");
  h.emit("session_start");
  assert.equal(injected(h), "agent-mail send");
  mock.timers.tick(5 * MINUTE);
  assert.equal(h.sent.length, 0);
});

test("Pi and OMP manifests expose only the production entry point", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/agent-mail.ts"]);
  assert.deepEqual(manifest.omp.extensions, ["./extensions/agent-mail.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
});
