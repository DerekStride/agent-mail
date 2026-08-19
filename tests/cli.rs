use std::fs;

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
    fs::create_dir(root.path().join("receiver-e5f6g7h8")).unwrap();

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
        .join("receiver-e5f6g7h8/inbox/new")
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
        .join("receiver-e5f6g7h8/inbox/cur")
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
    fs::create_dir(root.path().join("receiver-e5f6g7h8")).unwrap();

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
