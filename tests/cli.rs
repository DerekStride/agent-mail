use assert_cmd::Command;
use predicates::prelude::*;
use std::os::unix::fs::PermissionsExt;
use std::{env, fs};
use tempfile::TempDir;
use ulid::Ulid;

fn command(root: &TempDir) -> Command {
    let mut command = Command::cargo_bin("agent-mail").unwrap();
    command
        .env("AGENT_MAIL_ROOT", root.path())
        .env("PATH", "/usr/bin:/bin");
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
    assert!(Ulid::from_string(&message_id).is_ok());
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
        .args(["read", &message_id])
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
fn json_send_receipt_describes_delivery() {
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
            "--json",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let receipt: serde_json::Value = serde_json::from_slice(&output).unwrap();
    let message_id = receipt["id"].as_str().unwrap();

    assert!(Ulid::from_string(message_id).is_ok());
    assert_eq!(receipt["recipient"], "receiver");
    assert_eq!(receipt["sender"], "sender");
    assert_eq!(receipt["subject"], "handoff");
    assert_eq!(receipt["state"], "delivered");
    assert!(receipt["timestamp"]
        .as_str()
        .is_some_and(|timestamp| timestamp.ends_with('Z')));
    assert_eq!(
        receipt["mailbox"],
        root.path().join("receiver/inbox").display().to_string()
    );
    assert!(root
        .path()
        .join("receiver/inbox/new")
        .join(format!("{message_id}.md"))
        .is_file());
}

#[test]
fn json_addr_describes_recipient_mailbox() {
    let root = tempfile::tempdir().unwrap();

    let output = command(&root)
        .args(["addr", "receiver", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let address: serde_json::Value = serde_json::from_slice(&output).unwrap();

    assert_eq!(address["recipient"], "receiver");
    assert_eq!(
        address["mailbox"],
        root.path().join("receiver/inbox").display().to_string()
    );
    assert!(!root.path().join("receiver").exists());
}

#[test]
fn json_scan_describes_unread_messages() {
    let root = tempfile::tempdir().unwrap();

    command(&root)
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
        .success();

    let output = command(&root)
        .args(["scan", "--to", "receiver", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let entries: Vec<serde_json::Value> = serde_json::from_slice(&output).unwrap();

    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0]["mailbox"],
        root.path().join("receiver/inbox").display().to_string()
    );
    assert_eq!(entries[0]["sender"], "sender");
    assert_eq!(entries[0]["subject"], "handoff");
    assert!(Ulid::from_string(entries[0]["id"].as_str().unwrap()).is_ok());
}

#[test]
fn json_scan_empty_result_is_an_array() {
    let root = tempfile::tempdir().unwrap();

    let output = command(&root)
        .args(["scan", "--all", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let entries: Vec<serde_json::Value> = serde_json::from_slice(&output).unwrap();

    assert!(entries.is_empty());
}

#[test]
fn json_receipt_describes_message_state() {
    let root = tempfile::tempdir().unwrap();

    let output = command(&root)
        .args(["send", "--to", "receiver", "--body", "hello"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let message_id = String::from_utf8(output).unwrap().trim().to_string();

    let output = command(&root)
        .args(["receipt", &message_id, "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let receipt: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(receipt["id"], message_id);
    assert_eq!(receipt["recipient"], "receiver");
    assert_eq!(receipt["state"], "unread");
    assert!(receipt["delivered_at"]
        .as_str()
        .is_some_and(|timestamp| timestamp.ends_with('Z')));
    assert!(receipt["age_hours"].as_i64().is_some_and(|age| age >= 0));

    command(&root)
        .args(["read", &message_id])
        .assert()
        .success();

    let output = command(&root)
        .args(["receipt", &message_id, "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let receipt: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(receipt["state"], "read");
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
        .args(["read", &message_id, "--peek"])
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
fn prime_teaches_the_agent_communication_workflow() {
    command(&tempfile::tempdir().unwrap())
        .args(["prime"])
        .assert()
        .success()
        .stdout(predicate::str::contains("agent-id prime"))
        .stdout(predicate::str::contains("agent-mail send"))
        .stdout(predicate::str::contains("agent-mail read"))
        .stdout(predicate::str::contains("agent-mail receipt"))
        .stdout(predicate::str::contains("scan --to RECIPIENT --json"))
        .stdout(predicate::str::contains("addr RECIPIENT --json"))
        .stdout(predicate::str::contains("receipt MSGID --json"));
}

#[test]
fn agent_id_slug_selects_mailbox_directory() {
    let root = tempfile::tempdir().unwrap();
    let legacy = root.path().join("Gienah Oak of Darkwood/inbox");
    fs::create_dir_all(&legacy).unwrap();
    let tools = tempfile::tempdir().unwrap();
    let agent_id = tools.path().join("agent-id");
    fs::write(
        &agent_id,
        "#!/bin/sh\nprintf '%s\\n' '{\"version\":1,\"session_id\":\"smoke-session\",\"name\":\"Gienah Oak of Darkwood\",\"slug\":\"gienah-oak-darkwood\",\"first_name\":\"Gienah\",\"family_name\":\"Oak\",\"realm\":\"Darkwood\"}'\n",
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

    let output = command(&root)
        .env("PATH", path)
        .env("AGENT_MAIL_ID", "smoke-session")
        .args(["send", "--to", "smoke-session", "--body", "hello", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let receipt: serde_json::Value = serde_json::from_slice(&output).unwrap();
    let message_id = receipt["id"].as_str().unwrap();
    assert!(Ulid::from_string(message_id).is_ok());
    assert_eq!(receipt["recipient"], "gienah-oak-darkwood");
    assert_eq!(receipt["sender"], "Gienah Oak of Darkwood");

    let message_path = fs::read_dir(root.path().join("gienah-oak-darkwood/inbox/new"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let message = fs::read_to_string(message_path).unwrap();
    assert!(message.contains("From: Gienah Oak of Darkwood"));
    assert!(message.contains("To: Gienah Oak of Darkwood"));

    assert!(root.path().join("gienah-oak-darkwood/inbox/new").is_dir());
    assert!(legacy.is_dir());
    assert!(!root.path().join("smoke-session").exists());
}

#[test]
fn installed_agent_id_lookup_failure_does_not_use_raw_mailbox() {
    let root = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let agent_id = tools.path().join("agent-id");
    fs::write(
        &agent_id,
        "#!/bin/sh\nprintf '%s\\n' 'identity not registered' >&2\nexit 1\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&agent_id).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&agent_id, permissions).unwrap();
    let path = format!("{}:/usr/bin:/bin", tools.path().display());

    command(&root)
        .env("PATH", path)
        .args(["send", "--to", "unregistered-session", "--body", "hello"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("agent-id lookup failed"));

    assert!(!root.path().join("unregistered-session").exists());
}

#[test]
fn addr_resolves_without_creating_mailbox() {
    let root = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let agent_id = tools.path().join("agent-id");
    fs::write(
        &agent_id,
        "#!/bin/sh\nprintf '%s\\n' '{\"version\":1,\"session_id\":\"smoke-session\",\"name\":\"Gienah Oak of Darkwood\",\"slug\":\"gienah-oak-darkwood\",\"first_name\":\"Gienah\",\"family_name\":\"Oak\",\"realm\":\"Darkwood\"}'\n",
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

    let output = command(&root)
        .env("PATH", path)
        .args(["addr", "smoke-session"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();

    assert_eq!(
        String::from_utf8(output).unwrap(),
        format!("{}/gienah-oak-darkwood/inbox\n", root.path().display())
    );
    assert!(!root.path().join("gienah-oak-darkwood").exists());
}

#[test]
fn scan_lists_unread_headers_for_one_recipient() {
    let root = tempfile::tempdir().unwrap();

    command(&root)
        .args([
            "send",
            "--to",
            "receiver",
            "--from",
            "sender",
            "--subject",
            "handoff",
            "--body",
            "Unread body",
        ])
        .assert()
        .success();

    command(&root)
        .args(["scan", "--to", "receiver"])
        .assert()
        .success()
        .stdout(predicate::str::contains("receiver/inbox"))
        .stdout(predicate::str::contains("from:sender"))
        .stdout(predicate::str::contains("handoff"))
        .stdout(predicate::str::contains("Unread body").not());
}

#[test]
fn scan_all_lists_each_agent_inbox() {
    let root = tempfile::tempdir().unwrap();

    for recipient in ["alpha", "beta"] {
        command(&root)
            .args([
                "send",
                "--to",
                recipient,
                "--subject",
                recipient,
                "--body",
                "body",
            ])
            .assert()
            .success();
    }

    command(&root)
        .args(["scan", "--all"])
        .assert()
        .success()
        .stdout(predicate::str::contains("alpha/inbox"))
        .stdout(predicate::str::contains("beta/inbox"))
        .stdout(predicate::str::contains("alpha"))
        .stdout(predicate::str::contains("beta"));
}

#[test]
fn discard_moves_unread_message_to_trash() {
    let root = tempfile::tempdir().unwrap();
    let message_id = String::from_utf8(
        command(&root)
            .args(["send", "--to", "receiver", "--body", "discard me"])
            .assert()
            .success()
            .get_output()
            .stdout
            .clone(),
    )
    .unwrap()
    .trim()
    .to_string();

    let source = root
        .path()
        .join("receiver/inbox/new")
        .join(format!("{message_id}.md"));
    let destination = root
        .path()
        .join("receiver/inbox/.Trash/new")
        .join(format!("{message_id}.md"));

    command(&root)
        .args(["discard", &message_id])
        .assert()
        .success();

    assert!(!source.exists());
    assert!(destination.is_file());
    command(&root)
        .args(["receipt", &message_id])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("discarded\t"));
    command(&root)
        .args(["scan", "--to", "receiver"])
        .assert()
        .success()
        .stdout(predicate::str::contains("(no unread messages)"));
}

#[test]
fn discard_preserves_read_maildir_state() {
    let root = tempfile::tempdir().unwrap();
    let message_id = String::from_utf8(
        command(&root)
            .args(["send", "--to", "receiver", "--body", "read then discard"])
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
        .args(["read", &message_id])
        .assert()
        .success();
    command(&root)
        .args(["discard", &message_id])
        .assert()
        .success();

    assert!(root
        .path()
        .join("receiver/inbox/.Trash/cur")
        .join(format!("{message_id}.md"))
        .is_file());
    assert!(!root
        .path()
        .join("receiver/inbox/.Trash/new")
        .join(format!("{message_id}.md"))
        .exists());
}
