# agent-mail

`agent-mail` is a local Maildir message bus for coding-agent sessions.

It uses ordinary directories and atomic renames instead of a daemon, network service, database, or lockfile. The identity layer is intentionally separate: when available, `agent-id` supplies a human-readable slug; this project owns mailbox directories, message delivery, and read state.

## Install

### Homebrew

```bash
brew install derekstride/tap/agent-mail
```

### Cargo

```bash
cargo install agent-mail
```

### Release binary

Download the archive for your macOS architecture from [GitHub Releases](https://github.com/DerekStride/agent-mail/releases/latest), extract it, and place `agent-mail` on `PATH`.

## Agent instructions

Run this first in an agent workflow:

```bash
agent-mail prime
```

`prime` prints the storage model, addressing rules, safety boundaries, examples, and generated command reference. Use command-specific help for flags:

```bash
agent-mail send --help
agent-mail read --help
agent-mail receipt --help
```

## Storage model

The default mail root is `/tmp/agent-mail`; override it with `AGENT_MAIL_ROOT`.

agent-mail creates the recipient directory and Maildir on first delivery. If `agent-id` is installed and can resolve the identifier, the slug is used; otherwise the supplied session ID is used directly.

```text
$AGENT_MAIL_ROOT/<recipient>/
└── inbox/
    ├── tmp/  message is being written
    ├── new/  delivered and unread
    └── cur/  read and retained
```

`send` writes a complete RFC-822-shaped message to `tmp/`, then atomically renames it into `new/`. `read` moves it into `cur/` unless `--peek` is used. `receipt` infers state from the directory containing the message.

The root is local and ephemeral. Do not use it for information that must survive reboot, temporary-file cleanup, or machine loss.

## Commands

```bash
# Send an inline message; body can also come from --body-file or stdin.
agent-mail send --to smoke-session --from coordinator \
  --subject "Need evidence" \
  --body "Please inspect the parser boundary."

# Read the oldest unread message.
agent-mail read --to smoke-session

# List unread headers without marking messages read.
agent-mail scan --to smoke-session
agent-mail scan --all

# Inspect a specific message without changing state.
agent-mail read --to smoke-session --id MSGID --peek

# Check whether a sent message remains unread or has been read.
agent-mail receipt MSGID
```

Recipients may be supplied as a session ID, canonical agent name, or agent slug. If `agent-id` is available and resolves the identifier, its slug selects the mailbox directory; otherwise the identifier itself is used under `AGENT_MAIL_ROOT`.

Human recipients are intentionally deferred; see the future `sq` task for that feature.

## Development

```bash
cargo fmt --check
cargo test
cargo run -- prime
```

## Releases

Publishing a GitHub release or pushing a `v*` tag runs the release workflow. It verifies the Cargo version, builds macOS arm64 and Intel archives, uploads checksums to the GitHub release, publishes to crates.io, and updates the Homebrew tap when `HOMEBREW_TAP_TOKEN` is configured.

The repository workflow expects these GitHub secrets:

- `CARGO_REGISTRY_TOKEN`
- `HOMEBREW_TAP_TOKEN`

## License

MIT. See [LICENSE.md](LICENSE.md).
