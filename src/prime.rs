use anyhow::Result;

use crate::cli::PrimeArgs;

const PRELUDE: &str = r#"# agent-mail — local Maildir messaging for coding agents

Use `agent-mail` to leave a message for another local agent session. It is a filesystem-backed dead drop: no daemon, network transport, database, or identity allocator is required.

The identity layer is deliberately outside this tool. If `agent-id` is available, agent-mail uses its canonical slug for a human-readable mailbox directory; without it, session IDs work directly. agent-mail owns mailbox directory creation.

## Storage model

The default root is `/tmp/agent-mail`; override it with `AGENT_MAIL_ROOT`.

Each recipient has an inbox:

```text
$AGENT_MAIL_ROOT/<recipient>/inbox/
├── tmp/  message is being written
├── new/  delivered and unread
├── cur/  read and retained
└── .Trash/
    ├── tmp/
    ├── new/  soft-deleted unread message
    └── cur/  soft-deleted read message
```

A message is written completely in `tmp/` and atomically renamed into `new/`. Reading moves it from `new/` to `cur/`. The directory is the state; no mutable read flag is needed.

Message IDs are 26-character uppercase ULIDs. They are filename-safe and lexicographically sortable; use the complete ID printed by `send`.

## Workflow

1. Send a useful request or result. Use a subject and put longer bodies in a file or stdin.
2. Save the message ID printed by `send` when delivery confirmation matters.
3. Use `scan` to find a message ID, then read it directly with `read <MSGID>`.
4. Use `receipt` instead of sending a bare acknowledgement.
5. Keep durable work in the repository, issues, or commits. `/tmp/agent-mail` is local and ephemeral.

## Addressing

Recipients may be supplied as a session ID, canonical agent name, or agent slug. If `agent-id` is installed and knows the identifier, its slug selects the mailbox directory; otherwise the identifier itself is used as the directory name. The tool creates the recipient directory and Maildir on first delivery.

## OMP integration

The optional `extensions/agent-mail.ts` extension injects only `AGENT_MAIL_ID` into Bash calls that invoke `agent-mail`. It checks the current inbox every minute; after five minutes without user or agent activity, unread messages queue one header-only follow-up turn. It does not modify the parent shell or unrelated Bash commands. Reload OMP after installing or changing the extension.

## Message state

- `.Trash/new/` or `.Trash/cur/`: soft-deleted and retained
- absent: never delivered or removed

Messages use RFC-822-shaped headers followed by a plain-text body. `receipt` infers state from the file location and reports `discarded` for messages in `.Trash`. It cannot distinguish a message that was never delivered from one removed outside the Maildir.

## Boundaries

This is a same-machine, same-filesystem transport. It has no authentication, encryption, wakeup loop, stale-message escalation, or cross-host delivery. Those concerns belong to the harness or a separate integration layer.

## Examples

```bash
# Inline body
agent-mail send --to smoke-session --from coordinator --subject "Need evidence" \
  --body "Please inspect the parser boundary and report the failing case."

# File or stdin body
agent-mail send --to smoke-session --subject "Handoff" --body-file findings.md
printf '%s\n' "The fix is ready for review." | agent-mail send --to coordinator

# List unread headers without reading message bodies
agent-mail scan --to smoke-session
agent-mail scan --all

# Show the resolved inbox path without creating it
agent-mail addr smoke-session

# Soft-delete a message while preserving its original read state
agent-mail discard MSGID

# Read and reply
agent-mail read MSGID
agent-mail send --to coordinator --in-reply-to MSGID --subject "re: Handoff" \
  --body "The requested inspection is complete."

# Check whether a message was read
agent-mail receipt MSGID
```
"#;

pub fn execute(args: &PrimeArgs) -> Result<()> {
    println!("{}", generate(args.prelude));
    Ok(())
}

pub fn generate(prelude_only: bool) -> String {
    if prelude_only {
        return PRELUDE.to_string();
    }

    let mut manual = PRELUDE.to_string();
    manual.push_str("\n\n## Command reference\n\n");

    let command = crate::cli::build_cli();
    for subcommand in command.get_subcommands() {
        if matches!(subcommand.get_name(), "prime" | "help") {
            continue;
        }

        manual.push_str(&format!("### `agent-mail {}`\n\n", subcommand.get_name()));
        manual.push_str("```text\n");
        manual.push_str(&subcommand.clone().render_long_help().to_string());
        if !manual.ends_with('\n') {
            manual.push('\n');
        }
        manual.push_str("```\n\n");
    }

    manual
}

pub fn root_after_help() -> String {
    "Agent workflow:\n  agent-mail prime       Output the complete workflow manual\n  agent-mail <command> --help\n                         Read command-specific options and examples\n\nThe identity layer owns names and recipient directory provisioning. agent-mail owns only local message delivery and read state.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prime_contains_workflow_and_all_supported_commands() {
        let manual = generate(false);
        assert!(manual.contains("## Storage model"));
        assert!(manual.contains("### `agent-mail send`"));
        assert!(manual.contains("### `agent-mail read`"));
        assert!(manual.contains("### `agent-mail discard`"));
        assert!(manual.contains("### `agent-mail receipt`"));
        assert!(manual.contains("identity layer"));
    }

    #[test]
    fn prelude_skips_generated_command_reference() {
        let manual = generate(true);
        assert!(manual.contains("## Workflow"));
        assert!(!manual.contains("## Command reference"));
    }
}
