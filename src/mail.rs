use std::{
    env, fs,
    fs::OpenOptions,
    io::{self, Read as IoRead, Write},
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::fmt::Write as FormatWrite;
use ulid::Ulid;

use crate::cli::{DiscardArgs, ReadArgs, ReceiptArgs, ScanArgs, SendArgs};

pub const MAIL_ROOT_ENV: &str = "AGENT_MAIL_ROOT";
pub const MAIL_ID_ENV: &str = "AGENT_MAIL_ID";
const DEFAULT_MAIL_ROOT: &str = "/tmp/agent-mail";
const TRASH_DIR: &str = ".Trash";

pub fn send(args: &SendArgs) -> Result<()> {
    let root = mail_root();
    let mailbox = resolve_mailbox(&root, &args.to)?;
    let sender_id = args.from.clone().or_else(|| env::var(MAIL_ID_ENV).ok());
    let sender = sender_id
        .as_deref()
        .and_then(agent_id_identity)
        .map(|identity| identity.name)
        .or(sender_id)
        .unwrap_or_else(|| "unknown".to_string());
    let to = mailbox
        .identity
        .as_ref()
        .map(|identity| identity.name.clone())
        .unwrap_or_else(|| args.to.clone());
    let reply_to = args.reply_to.as_deref().map(|value| {
        agent_id_identity(value)
            .map(|identity| identity.name)
            .unwrap_or_else(|| value.to_string())
    });
    let subject = args.subject.as_deref().unwrap_or("(no subject)");
    validate_header("From", &sender)?;
    validate_header("To", &to)?;
    validate_optional_header("Reply-To", reply_to.as_deref())?;
    validate_header("Subject", subject)?;
    validate_optional_header("In-Reply-To", args.in_reply_to.as_deref())?;

    let body = match (&args.body, &args.body_file) {
        (Some(_), Some(_)) => bail!("--body and --body-file are mutually exclusive"),
        (Some(body), None) => body.clone(),
        (None, Some(path)) => fs::read_to_string(path)
            .with_context(|| format!("reading message body from {}", path.display()))?,
        (None, None) => {
            let mut body = String::new();
            io::stdin()
                .read_to_string(&mut body)
                .context("reading message body from stdin")?;
            body
        }
    };

    let now = Utc::now();
    let msgid = generate_msgid();
    let message = format_message(
        &sender,
        &to,
        reply_to.as_deref(),
        now,
        &msgid,
        args.in_reply_to.as_deref(),
        subject,
        &body,
    );

    let inbox = ensure_maildir(&mailbox.path)?;
    let tmp = inbox.join("tmp").join(format!("{msgid}.md"));
    let destination = inbox.join("new").join(format!("{msgid}.md"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .with_context(|| format!("creating temporary message {}", tmp.display()))?;
    file.write_all(message.as_bytes())
        .with_context(|| format!("writing temporary message {}", tmp.display()))?;
    file.sync_all()
        .with_context(|| format!("flushing temporary message {}", tmp.display()))?;
    drop(file);

    fs::rename(&tmp, &destination).with_context(|| {
        format!(
            "atomically delivering message from {} to {}",
            tmp.display(),
            destination.display()
        )
    })?;
    println!("{msgid}");
    Ok(())
}
pub fn scan(args: &ScanArgs) -> Result<()> {
    match (args.to.as_deref(), args.all) {
        (Some(_), true) | (None, false) => {
            bail!("scan requires exactly one of --to ID or --all")
        }
        _ => {}
    }

    let root = mail_root();
    let mut inboxes = if args.all {
        discover_inboxes(&root)?
    } else {
        vec![resolve_mailbox(&root, args.to.as_deref().expect("validated recipient"))?.path]
    };
    inboxes.sort();

    let mut found = false;
    for inbox in inboxes {
        for message in unread_messages(&inbox)? {
            found = true;
            let message_id = message
                .file_stem()
                .and_then(|name| name.to_str())
                .context("unread message has no valid filename")?;
            let from = message_header(&message, "From")?.unwrap_or_else(|| "unknown".to_string());
            let subject = message_header(&message, "Subject")?.unwrap_or_default();
            println!(
                "{}\t{}\tfrom:{}\t{}",
                inbox.display(),
                message_id,
                from,
                subject
            );
        }
    }

    if !found {
        println!("(no unread messages)");
    }
    Ok(())
}

pub fn read(args: &ReadArgs) -> Result<()> {
    let message_id = normalize_message_id(&args.message_id)?;
    let (inbox, message) = find_message_by_id(&mail_root(), &message_id)?
        .with_context(|| format!("no message with ID '{message_id}'"))?;

    let contents = fs::read_to_string(&message)
        .with_context(|| format!("reading message {}", message.display()))?;
    print!("{contents}");

    if !args.peek
        && message
            .parent()
            .is_some_and(|parent| parent.ends_with("new"))
    {
        let destination = inbox.join("cur").join(
            message
                .file_name()
                .context("message path has no filename")?,
        );
        fs::create_dir_all(inbox.join("cur"))
            .with_context(|| format!("creating {}", inbox.join("cur").display()))?;
        fs::rename(&message, &destination).with_context(|| {
            format!(
                "marking message read by moving {} to {}",
                message.display(),
                destination.display()
            )
        })?;
    }

    Ok(())
}

pub fn discard(args: &DiscardArgs) -> Result<()> {
    let message_id = normalize_message_id(&args.message_id)?;
    let Some((inbox, source)) = find_message_by_id(&mail_root(), &message_id)? else {
        return Ok(());
    };
    let state = source
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .context("message path has no state")?;

    let trash = inbox.join(TRASH_DIR);
    for directory in ["tmp", "new", "cur"] {
        fs::create_dir_all(trash.join(directory))
            .with_context(|| format!("creating {}", trash.join(directory).display()))?;
    }
    let filename = source.file_name().context("message path has no filename")?;
    let destination = trash.join(state).join(filename);
    fs::rename(&source, &destination).with_context(|| {
        format!(
            "soft-deleting message by moving {} to {}",
            source.display(),
            destination.display()
        )
    })?;
    Ok(())
}
pub fn receipt(args: &ReceiptArgs) -> Result<()> {
    let message_id = normalize_message_id(&args.message_id)?;
    let root = mail_root();

    for inbox in discover_inboxes(&root)? {
        let state = if existing_message(&inbox, "cur", &message_id).is_some() {
            "read"
        } else if existing_message(&inbox, "new", &message_id).is_some() {
            "unread"
        } else if existing_message(&inbox, ".Trash/cur", &message_id).is_some() {
            "discarded"
        } else if existing_message(&inbox, ".Trash/new", &message_id).is_some() {
            "discarded"
        } else {
            continue;
        };

        let recipient = inbox
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .unwrap_or("unknown");
        let age = message_age_hours(&message_id);
        let delivered = delivered_timestamp(&message_id);
        println!("{state}\t{message_id}\tto:{recipient}\tdelivered:{delivered}\t{age}h ago");
        return Ok(());
    }

    bail!("unknown\t{message_id}\tnot in any inbox (never delivered or removed)")
}

fn mail_root() -> PathBuf {
    env::var_os(MAIL_ROOT_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_MAIL_ROOT))
}

#[derive(Debug, Deserialize, Clone)]
struct IdentityAssignment {
    name: String,
    slug: String,
}

#[derive(Debug)]
struct ResolvedMailbox {
    path: PathBuf,
    identity: Option<IdentityAssignment>,
}

fn resolve_mailbox(root: &Path, input: &str) -> Result<ResolvedMailbox> {
    validate_component(input, "recipient identifier")?;
    let identity = agent_id_identity(input);
    let mailbox_id = identity
        .as_ref()
        .map(|assignment| assignment.slug.as_str())
        .unwrap_or(input);
    validate_component(mailbox_id, "mailbox identifier")?;
    Ok(ResolvedMailbox {
        path: root.join(mailbox_id).join("inbox"),
        identity,
    })
}

fn agent_id_identity(input: &str) -> Option<IdentityAssignment> {
    let output = Command::new("agent-id")
        .env("AGENT_ID_SESSION_ID", input)
        .args(["lookup", "--json"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let identity: IdentityAssignment = serde_json::from_slice(&output.stdout).ok()?;
    validate_component(&identity.slug, "agent-id slug")
        .ok()
        .map(|_| identity)
}

fn validate_component(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\0')
    {
        bail!("invalid {label}: {value:?}");
    }
    Ok(())
}

fn validate_header(label: &str, value: &str) -> Result<()> {
    if value.contains('\r') || value.contains('\n') {
        bail!("{label} cannot contain a newline");
    }
    Ok(())
}

fn validate_optional_header(label: &str, value: Option<&str>) -> Result<()> {
    if let Some(value) = value {
        validate_header(label, value)?;
    }
    Ok(())
}

fn ensure_maildir(inbox: &Path) -> Result<&Path> {
    for directory in ["tmp", "new", "cur"] {
        fs::create_dir_all(inbox.join(directory))
            .with_context(|| format!("creating {}", inbox.join(directory).display()))?;
    }
    Ok(inbox)
}

fn format_message(
    from: &str,
    to: &str,
    reply_to: Option<&str>,
    date: DateTime<Utc>,
    message_id: &str,
    in_reply_to: Option<&str>,
    subject: &str,
    body: &str,
) -> String {
    let mut message = String::new();
    writeln!(message, "From: {from}").unwrap();
    writeln!(message, "To: {to}").unwrap();
    if let Some(reply_to) = reply_to {
        writeln!(message, "Reply-To: {reply_to}").unwrap();
    }
    writeln!(message, "Date: {}", date.format("%Y-%m-%dT%H:%M:%SZ")).unwrap();
    writeln!(message, "Message-ID: {message_id}").unwrap();
    if let Some(in_reply_to) = in_reply_to {
        writeln!(message, "In-Reply-To: {in_reply_to}").unwrap();
    }
    writeln!(message, "Subject: {subject}").unwrap();
    message.push('\n');
    message.push_str(body);
    if !body.ends_with('\n') {
        message.push('\n');
    }
    message
}

fn generate_msgid() -> String {
    Ulid::generate().to_string()
}

fn normalize_message_id(value: &str) -> Result<String> {
    let filename = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .context("message ID must be a filename")?;
    let message_id = filename.strip_suffix(".md").unwrap_or(filename);
    if message_id.is_empty() || message_id.contains('/') || message_id.contains('\0') {
        bail!("invalid message ID: {value:?}");
    }
    if Ulid::from_string(message_id).is_err() {
        bail!("message ID must be a valid ULID: {value:?}");
    }
    Ok(message_id.to_string())
}

fn find_message_by_id(root: &Path, message_id: &str) -> Result<Option<(PathBuf, PathBuf)>> {
    for inbox in discover_inboxes(root)? {
        for state in ["new", "cur"] {
            if let Some(path) = existing_message(&inbox, state, message_id) {
                return Ok(Some((inbox, path)));
            }
        }
    }
    Ok(None)
}

fn existing_message(inbox: &Path, state: &str, message_id: &str) -> Option<PathBuf> {
    let path = inbox.join(state).join(format!("{message_id}.md"));
    path.is_file().then_some(path)
}

fn unread_messages(inbox: &Path) -> Result<Vec<PathBuf>> {
    let mut messages = read_dir_or_empty(&inbox.join("new"))?
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "md"))
        .collect::<Vec<_>>();
    messages.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    Ok(messages)
}

fn message_header(path: &Path, header: &str) -> Result<Option<String>> {
    let contents = fs::read_to_string(path)
        .with_context(|| format!("reading message headers from {}", path.display()))?;
    let prefix = format!("{header}: ");
    Ok(contents
        .lines()
        .take_while(|line| !line.is_empty())
        .find_map(|line| line.strip_prefix(&prefix).map(ToOwned::to_owned)))
}

fn discover_inboxes(root: &Path) -> Result<Vec<PathBuf>> {
    let mut inboxes = Vec::new();
    for entry in read_dir_or_empty(root)? {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let direct = path.join("inbox");
        if direct.is_dir() {
            inboxes.push(direct);
        }
    }
    Ok(inboxes)
}

fn read_dir_or_empty(path: &Path) -> Result<Vec<fs::DirEntry>> {
    match fs::read_dir(path) {
        Ok(entries) => entries
            .collect::<std::result::Result<Vec<_>, _>>()
            .with_context(|| format!("reading directory {}", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error).with_context(|| format!("reading directory {}", path.display())),
    }
}

fn message_timestamp(message_id: &str) -> Option<DateTime<Utc>> {
    let ulid = Ulid::from_string(message_id).ok()?;
    DateTime::<Utc>::from_timestamp_millis(ulid.timestamp_ms() as i64)
}

fn delivered_timestamp(message_id: &str) -> String {
    message_timestamp(message_id)
        .map(|timestamp| timestamp.format("%Y%m%dT%H%M%SZ").to_string())
        .unwrap_or_else(|| message_id.to_string())
}

fn message_age_hours(message_id: &str) -> i64 {
    message_timestamp(message_id)
        .map(|timestamp| (Utc::now() - timestamp).num_hours().max(0))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn message_format_preserves_mail_headers_and_body() {
        let date = Utc.with_ymd_and_hms(2026, 8, 19, 20, 0, 0).unwrap();
        let message = format_message(
            "sender",
            "receiver",
            Some("reply-target"),
            date,
            "01D39ZY06FGSCTVN4T2V9PKHFZ",
            Some("previous"),
            "handoff",
            "done",
        );

        assert_eq!(
            message,
            "From: sender\nTo: receiver\nReply-To: reply-target\nDate: 2026-08-19T20:00:00Z\nMessage-ID: 01D39ZY06FGSCTVN4T2V9PKHFZ\nIn-Reply-To: previous\nSubject: handoff\n\ndone\n"
        );
    }

    #[test]
    fn generated_message_ids_are_ulids() {
        let message_id = generate_msgid();

        assert_eq!(message_id.len(), 26);
        assert!(Ulid::from_string(&message_id).is_ok());
        assert!(message_timestamp(&message_id).is_some());
    }

    #[test]
    fn non_ulid_message_ids_are_rejected() {
        let error = normalize_message_id("20260820T145311Z-93848-834298000-0").unwrap_err();
        assert!(error.to_string().contains("valid ULID"));
    }

    #[test]
    fn session_id_resolves_to_mailbox_without_identity_tool() {
        let root = tempfile::tempdir().unwrap();

        assert_eq!(
            resolve_mailbox(root.path(), "smoke-session").unwrap().path,
            root.path().join("smoke-session/inbox")
        );
    }

    #[test]
    fn recipient_identifiers_cannot_escape_mail_root() {
        let root = tempfile::tempdir().unwrap();

        let error = resolve_mailbox(root.path(), "../escape").unwrap_err();
        assert!(error.to_string().contains("invalid recipient identifier"));
    }
}
