use anyhow::Result;

use crate::cli::PrimeArgs;

const PRELUDE: &str = r#"# agent-mail — local Maildir messaging for coding agents

Use `agent-mail` to leave a message for another local agent session or a human. It is a filesystem-backed dead drop: no daemon, network transport, database, or identity allocator is required.

The identity layer is deliberately outside this tool. It provisions recipient directories and supplies IDs; agent-mail only resolves those directories, writes messages, and reports read state.

## Storage model

The default root is `/tmp/agent`; override it with `AGENT_MAIL_ROOT`.

Each provisioned recipient has an inbox:

```text
$AGENT_MAIL_ROOT/<recipient>/inbox/
├── tmp/  message is being written
├── new/  delivered and unread
└── cur/  read and retained
```

A message is written completely in `tmp/` and atomically renamed into `new/`. Reading moves it from `new/` to `cur/`. The directory is the state; no mutable read flag is needed.

## Workflow

1. Send a useful request or result. Use a subject and put longer bodies in a file or stdin.
2. Save the message ID printed by `send` when delivery confirmation matters.
3. Read the oldest unread message, or use `--id` for a specific message.
4. Use `receipt` instead of sending a bare acknowledgement.
5. Keep durable work in the repository, issues, or commits. `/tmp/agent` is local and ephemeral.

## Addressing

An exact recipient directory is preferred. A bare agent name may resolve to one `<name>-*` directory; multiple matches fail rather than guess. Human inboxes use `humans/<handle>` or an email-like address. The identity layer must create the recipient directory before first delivery.

## Message state

- `new/`: delivered, unread
- `cur/`: read, retained for inspection or audit
- absent: discarded, pruned, or never delivered

Messages use RFC-822-shaped headers followed by a plain-text body. `receipt` infers state from the file location. It cannot distinguish a discarded message from one that was never delivered.

## Boundaries

This is a same-machine, same-filesystem transport. It has no authentication, encryption, wakeup loop, stale-message escalation, or cross-host delivery. Those concerns belong to the harness or a separate integration layer.

## Examples

```bash
# Inline body
agent-mail send --to worker-019fcdb2 --from coordinator --subject "Need evidence" \
  --body "Please inspect the parser boundary and report the failing case."

# File or stdin body
agent-mail send --to worker-019fcdb2 --subject "Handoff" --body-file findings.md
printf '%s\n' "The fix is ready for review." | agent-mail send --to coordinator

# Read and reply
agent-mail read --to worker-019fcdb2
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
