use std::os::unix::fs::PermissionsExt;
use std::{env, fs};

use assert_cmd::Command;
use predicates::prelude::*;
use tempfile::TempDir;

fn command(root: &TempDir) -> Command {
    let mut command = Command::cargo_bin("agent-mail").unwrap();
    command.env("AGENT_MAIL_ROOT", root.path());
    command
}

#[test]
fn send_read_and_receipt_track_maildir_state() {
    let root = tempfile::tempdir().unwrap();

    let output = command(&root)
        .args([
            "send",
            "--to",
            "receiver",
            "--from",
            "sender",
            "--subject",
            "handoff",
            "--body",
            "Tests are green.",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let message_id = String::from_utf8(output).unwrap().trim().to_string();

    let unread_path = root
        .path()
        .join("receiver/inbox/new")
        .join(format!("{message_id}.md"));
    assert!(unread_path.is_file());

    command(&root)
        .args(["receipt", &message_id])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("unread\t"));

    command(&root)
        .args(["read", "--to", "receiver"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Subject: handoff"))
        .stdout(predicate::str::contains("Tests are green."));

    assert!(!unread_path.exists());
    assert!(root
        .path()
        .join("receiver/inbox/cur")
        .join(format!("{message_id}.md"))
        .is_file());

    command(&root)
        .args(["receipt", &message_id])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("read\t"));
}

#[test]
fn peek_leaves_message_unread() {
    let root = tempfile::tempdir().unwrap();

    let message_id = String::from_utf8(
        command(&root)
            .args(["send", "--to", "receiver", "--body", "peek me"])
            .assert()
            .success()
            .get_output()
            .stdout
            .clone(),
    )
    .unwrap()
    .trim()
    .to_string();

    command(&root)
        .args(["read", "--to", "receiver", "--peek"])
        .assert()
        .success()
        .stdout(predicate::str::contains("peek me"));

    command(&root)
        .args(["receipt", &message_id])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("unread\t"));
}

#[test]
fn prime_teaches_the_supported_workflow() {
    command(&tempfile::tempdir().unwrap())
        .args(["prime"])
        .assert()
        .success()
        .stdout(predicate::str::contains("## Storage model"))
        .stdout(predicate::str::contains("agent-mail send"))
        .stdout(predicate::str::contains("agent-mail read"))
        .stdout(predicate::str::contains("agent-mail receipt"));
}

#[test]
fn agent_id_slug_selects_mailbox_directory() {
    let root = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let agent_id = tools.path().join("agent-id");
    fs::write(
        &agent_id,
        "#!/bin/sh\nprintf '%s\\n' '{\"slug\":\"gienah-oak-darkwood\"}'\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&agent_id).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&agent_id, permissions).unwrap();
    let path = format!(
        "{}:{}",
        tools.path().display(),
        env::var("PATH").unwrap_or_default()
    );

    command(&root)
        .env("PATH", path)
        .args(["send", "--to", "smoke-session", "--body", "hello"])
        .assert()
        .success();

    assert!(root.path().join("gienah-oak-darkwood/inbox/new").is_dir());
    assert!(!root.path().join("smoke-session").exists());
}
