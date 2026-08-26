use anyhow::Result;

use crate::cli::PrimeArgs;

const MANUAL: &str = r#"# AgentMail workflow

Use AgentMail to communicate with another local coding-agent session. It is asynchronous: send a complete request or result, then continue with work that does not depend on the reply.

## When to send mail

- Send a bounded request, handoff, decision, blocker, or result to a specific agent.
- Include enough context for the recipient to act without reading your conversation.
- Keep durable state in the repository, an issue, or a commit. AgentMail is not a durable record.
- Do not send secrets. Mail is local plain text without authentication or encryption.

## Find a recipient

Recipients can be session IDs, canonical agent names, or agent slugs.

If you need to understand Agent ID or discover other agents, run:

```bash
agent-id prime
```

## Send

Use a specific subject and an actionable body. Always prefer `--json` in agent workflows so parallel sends remain self-describing:

```bash
agent-mail send --to RECIPIENT \
  --subject "Inspect parser boundary" \
  --body "Find the failing input, identify the owning function, and send the evidence." \
  --json
```

For longer bodies, use a file or stdin; keep `--json`:

```bash
agent-mail send --to RECIPIENT --subject "Handoff" --body-file findings.txt --json
printf '%s\n' "The fix is ready for review." | agent-mail send --to RECIPIENT --json
```

`send` prints a bare message ID by default for human compatibility. With `--json`, it prints a stable receipt containing `id`, `recipient`, `sender`, `subject`, `timestamp`, `mailbox`, and `state`. The recipient is the resolved Agent ID slug when available, or the standalone recipient identifier when Agent ID is unavailable. Save the message ID when you need to reply in-thread or confirm the message state.

The OMP extension supplies your current session identity through `AGENT_MAIL_ID`. Normally omit `--from`; use it only to override the sender explicitly.

## Read and reply

An inbox notification includes the message ID. You can also list unread headers without changing their state:

```bash
agent-mail scan --to RECIPIENT
agent-mail scan --all
```

Read a message by ID:

```bash
agent-mail read MSGID
```

Reading marks unread mail as read. Use `--peek` only when the message must remain unread.

When replying, send to the `Reply-To` header when present; otherwise send to `From`. Preserve the original message ID:

```bash
agent-mail send --to SENDER \
  --in-reply-to MSGID \
  --subject "re: Inspect parser boundary" \
  --body "The failing case is empty input; parse_header owns the check."
```

## Confirm or discard

Check a sent message without sending a bare acknowledgement:

```bash
agent-mail receipt MSGID
```

Receipts report `unread`, `read`, or `discarded`. An unknown ID means agent-mail cannot find the message; it may never have been delivered or may have been removed.

Soft-delete a message only when retaining it in the active inbox is not useful:

```bash
agent-mail discard MSGID
```

## Boundaries

AgentMail works only between sessions sharing the same machine, filesystem, and mail root. The default root is temporary and may be cleared on reboot. Put lasting conclusions in the shared work product before relying on a message handoff.

## Exact command syntax

Use command help for flags and accepted values:

```bash
agent-mail <command> --help
```
"#;

pub fn execute(_args: &PrimeArgs) -> Result<()> {
    print!("{MANUAL}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prime_contains_the_agent_workflow() {
        let manual = MANUAL;
        assert!(manual.contains("agent-id prime"));
        assert!(manual.contains("agent-mail send"));
        assert!(manual.contains("agent-mail read"));
        assert!(manual.contains("agent-mail receipt"));
        assert!(manual.contains("agent-mail discard"));
    }

    #[test]
    fn prime_excludes_implementation_and_generated_reference() {
        let manual = MANUAL;
        assert!(!manual.contains("## Storage model"));
        assert!(!manual.contains("## Command reference"));
        assert!(!manual.contains("extensions/agent-mail.ts"));
    }
}
