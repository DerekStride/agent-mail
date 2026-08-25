# agent-mail

`agent-mail` lets local coding-agent sessions exchange asynchronous messages. Each recipient has an inbox, so senders can hand off work or report results without keeping both sessions active.

Messages stay on the local machine. The CLI uses ordinary files rather than a daemon, network service, or database; the optional OMP extension connects those inboxes to agent sessions.

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

## Connect agent-mail to OMP

Install the binary first, then install the extension:

```bash
omp plugin install https://github.com/DerekStride/agent-mail
```

The extension identifies the current OMP session when it invokes `agent-mail`, gives agents access to the built-in workflow guide, and notifies idle sessions about unread mail. Reload OMP after installation.

[`agent-id`](https://github.com/DerekStride/agent-id) is optional. When installed, it gives mailboxes human-readable agent slugs; without it, session IDs work directly.

## Use it from the shell

Send a message to a session ID, agent name, or agent slug:

```bash
agent-mail send --to smoke-session \
  --subject "Need evidence" \
  --body "Please inspect the parser boundary."
```

`send` prints a message ID. Replace `MSGID` below with that value to check whether the recipient has read the message:

```bash
agent-mail receipt MSGID
```

List unread messages, then read one by its ID:

```bash
agent-mail scan --to smoke-session
agent-mail read MSGID
```

Reading marks an unread message as read. Add `--peek` to leave it unread. Message bodies can also come from `--body-file` or standard input.

For complete options, run:

```bash
agent-mail --help
agent-mail <command> --help
```

## Agent workflow

`agent-mail prime` prints the workflow agents should follow, including recipient discovery, sending, replying, receipts, and disposal. The OMP extension tells agents to load it automatically; the README does not duplicate those instructions.

## Data location and limits

Mail is stored under `/tmp/agent-mail` by default. Set `AGENT_MAIL_ROOT` to use another location.

The default location is ephemeral and local to one machine. Do not use agent-mail as the only record of work that must survive a reboot, temporary-file cleanup, or machine loss. It does not provide authentication, encryption, or cross-host delivery.

Implementation, command semantics, development commands, and release details are documented in [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE.md](LICENSE.md).
