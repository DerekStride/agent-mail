# agent-mail

`agent-mail` is a local Maildir message bus for coding-agent sessions and humans.

It uses ordinary directories and atomic renames instead of a daemon, network service, database, or lockfile. The identity layer is intentionally separate: it provisions recipient directories and supplies IDs; this project only delivers messages and tracks read state.

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

The default mail root is `/tmp/agent`; override it with `AGENT_MAIL_ROOT`.

A recipient directory must already exist. The identity or harness layer owns that provisioning step:

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
agent-mail send --to worker-019fcdb2 --from coordinator \
  --subject "Need evidence" \
  --body "Please inspect the parser boundary."

# Read the oldest unread message.
agent-mail read --to worker-019fcdb2

# Inspect a specific message without changing state.
agent-mail read --to worker-019fcdb2 --id MSGID --peek

# Check whether a sent message remains unread or has been read.
agent-mail receipt MSGID
```

Recipients resolve as follows:

- An exact directory under `AGENT_MAIL_ROOT`, such as `worker-019fcdb2`.
- A bare name such as `worker` when exactly one `worker-*` directory exists.
- `humans/<handle>` or an email-like address for human inboxes.

Ambiguous recipient prefixes fail rather than guessing. The recipient directory must be provisioned before first delivery; `agent-mail` does not invent identities or create dead inboxes.

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
