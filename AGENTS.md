# Agent Mail repository guide

## Documentation boundaries

- `README.md` is for people evaluating, installing, and operating agent-mail. Keep it focused on what the project does and how to use it.
- `AGENTS.md` owns implementation details, contributor commands, and reference material.
- `agent-mail prime` owns instructions that tell coding agents when and how to use AgentMail. Keep those instructions in `src/prime.rs`, not the README.
- Clap help is the source of truth for exact CLI syntax. Do not copy generated help into prose documentation.

## Product boundary

agent-mail is a same-machine, same-filesystem message transport for coding-agent sessions. It owns mailbox creation, message delivery, read state, and soft deletion. It does not allocate identities, authenticate senders, encrypt messages, wake remote hosts, or provide durable storage.

`agent-id` is an optional identity layer. If it is unavailable, agent-mail uses the supplied session ID, name, or slug directly. When it is available, recipient lookup is authoritative: successful resolution routes through the immutable slug, and lookup failures are surfaced before mailbox creation.

## Code map

| Path | Responsibility |
|---|---|
| `src/cli.rs` | Clap command and argument definitions |
| `src/mail.rs` | Address resolution, Maildir operations, message formatting, and receipts |
| `src/prime.rs` | Agent-facing workflow printed by `agent-mail prime` |
| `src/main.rs` | CLI dispatch and top-level error reporting |
| `extensions/agent-mail.ts` | OMP session identity injection, persistent agent context, and inbox wakeups |
| `tests/cli.rs` | End-to-end CLI and Maildir behavior |
| `scripts/generate-homebrew-formula.sh` | Release-time Homebrew formula generation |

## Storage and state

`AGENT_MAIL_ROOT` selects the mail root; the default is `/tmp/agent-mail`. Each resolved recipient owns this Maildir:

```text
$AGENT_MAIL_ROOT/<recipient>/
└── inbox/
    ├── tmp/       message is being written
    ├── new/       delivered and unread
    ├── cur/       read and retained
    └── .Trash/
        ├── tmp/
        ├── new/   discarded while unread
        └── cur/   discarded after reading
```

Delivery creates the recipient Maildir when needed. `send` writes a new file with `create_new`, flushes it with `sync_all`, then atomically renames it from `tmp/` to `new/`. Preserve that complete-write-before-rename invariant.

`read` moves an unread message from `new/` to `cur/` unless `--peek` is set. `discard` moves a message into the matching `.Trash/new/` or `.Trash/cur/` directory, preserving its prior read state. The directory is the state; there is no mutable read flag.

Messages are plain text with RFC-822-shaped headers. IDs are uppercase 26-character ULIDs and filenames are `<MSGID>.md`. A receipt searches every inbox and reports `unread`, `read`, or `discarded`; an absent ID is ambiguous between never delivered and removed outside agent-mail.

## Identity and addressing

`AGENT_MAIL_ID` is the optional current session ID. `send` uses it as the default sender; `--from` overrides it.

For each sender or recipient identifier, `src/mail.rs` invokes `agent-id lookup <IDENTIFIER> --json`. A successful recipient lookup supplies the display name used in headers and the slug used as the mailbox directory. If Agent ID is unavailable, standalone recipient routing falls back to the supplied identifier; installed-command lookup failures are errors. Sender and reply display lookups remain best-effort.

Identifiers and resolved slugs must be one safe path component: non-empty, not `.` or `..`, and without `/` or NUL. Header values reject CR and LF to prevent header injection.

## Command semantics

| Command | Contract |
|---|---|
| `send` | Requires `--to`; accepts an inline body, `--body-file`, or stdin; creates the recipient inbox; prints the message ID only. |
| `scan` | Requires exactly one of `--to ID` or `--all`; prints unread headers without message bodies or state changes. |
| `addr` | Resolves and prints a recipient inbox path without creating it. |
| `read` | Finds a message globally by ID, prints it, and marks unread mail read unless `--peek` is set. |
| `discard` | Soft-deletes a known message while preserving read state; an absent valid ID is a successful no-op. |
| `receipt` | Finds a message globally and reports its state, recipient, delivery time, and age; an unknown ID exits with an error. |
| `prime` | Prints the agent-facing communication workflow. Exact command options remain in `<command> --help`. |

`send` keeps the bare message ID as its default output for human compatibility. Agent workflows should pass `--json` to receive a stable structured receipt containing `id`, `recipient`, `sender`, `subject`, `timestamp`, `mailbox`, and `state`. `recipient` is the resolved Agent ID slug when available, or the standalone recipient identifier when Agent ID is unavailable.

## OMP extension

`extensions/agent-mail.ts` installs one hidden persistent context message per branch under the stable `agent-mail-context-v2` type. The message directs agents to `agent-mail prime` without changing the visible conversation or repeatedly altering the prompt prefix.

For matching `agent-mail` invocations through OMP's Bash tool, the extension injects the current session ID as `AGENT_MAIL_ID`. It preserves a caller-provided value and does not modify the parent shell or unrelated Bash calls.

The extension scans the current inbox once per minute. After five minutes without user or agent activity, fresh unread messages trigger one header-only follow-up turn. Session start and switch reset the timer and wakeup state; shutdown clears them.

## Development

CI runs:

```bash
cargo fmt --all -- --check
cargo test --all --locked --verbose
```

Exercise the agent guide with:

```bash
cargo run -- prime
```

For local OMP extension development:

```bash
ln -sf "$PWD/extensions/agent-mail.ts" "$HOME/.omp/agent/extensions/agent-mail.ts"
```

Reload OMP after installing or changing the extension. If `agent-id` is unavailable, test the direct session-ID fallback rather than requiring it.

## Release reference

`.github/workflows/publish.yml` runs for published GitHub releases and `v*` tag pushes. It first verifies that the tag matches `Cargo.toml`. A published release builds arm64 and Intel macOS archives, uploads each archive and checksum, publishes to crates.io, and updates the Homebrew tap for non-prereleases when the tap token is configured.

Required repository secrets:

- `CARGO_REGISTRY_TOKEN`
- `HOMEBREW_TAP_TOKEN` for automatic tap updates
