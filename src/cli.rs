use std::path::PathBuf;

use clap::{Args, Command, CommandFactory, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "agent-mail",
    version,
    about = "Local Maildir message bus for coding agents",
    long_about = "agent-mail delivers local messages between coding-agent sessions and humans without a daemon or network service."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Deliver a message to an agent inbox
    Send(SendArgs),
    /// List unread messages for one recipient or all inboxes
    Scan(ScanArgs),
    /// Print the resolved inbox path for a recipient
    Addr(AddrArgs),
    /// Read a message by ID
    Read(ReadArgs),
    /// Soft-delete a message into the Maildir++ .Trash folder
    Discard(DiscardArgs),
    /// Report whether a sent message is unread, read, or absent
    Receipt(ReceiptArgs),
    /// Output the agent-facing workflow manual
    Prime(PrimeArgs),
}

#[derive(Debug, Args)]
pub struct SendArgs {
    /// Recipient session ID, canonical name, or agent slug
    #[arg(long, value_name = "ID")]
    pub to: String,

    /// Sender ID; defaults to AGENT_MAIL_ID or "unknown"
    #[arg(long, value_name = "ID")]
    pub from: Option<String>,

    /// Address to use when composing a reply
    #[arg(long, value_name = "ID")]
    pub reply_to: Option<String>,

    /// Subject line
    #[arg(long, value_name = "TEXT")]
    pub subject: Option<String>,

    /// Message ID this message replies to
    #[arg(long, value_name = "MSGID")]
    pub in_reply_to: Option<String>,

    /// Inline message body
    #[arg(short = 'm', long, value_name = "TEXT", conflicts_with = "body_file")]
    pub body: Option<String>,

    /// Read the message body from a file
    #[arg(long, value_name = "PATH", conflicts_with = "body")]
    pub body_file: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct ScanArgs {
    /// Recipient ID whose unread messages should be listed
    #[arg(long, value_name = "ID", conflicts_with = "all")]
    pub to: Option<String>,

    /// List unread messages in every agent inbox
    #[arg(long, conflicts_with = "to")]
    pub all: bool,
}

#[derive(Debug, Args)]
pub struct AddrArgs {
    /// Recipient session ID, canonical name, or agent slug
    #[arg(value_name = "RECIPIENT")]
    pub recipient: String,
}

#[derive(Debug, Args)]
pub struct DiscardArgs {
    /// Message ID to move to .Trash
    #[arg(value_name = "MSGID")]
    pub message_id: String,
}

#[derive(Debug, Args)]
pub struct ReadArgs {
    /// Message ID to read
    #[arg(value_name = "MSGID")]
    pub message_id: String,

    /// Print without moving an unread message to cur/
    #[arg(long)]
    pub peek: bool,
}

#[derive(Debug, Args)]
pub struct ReceiptArgs {
    /// Message ID printed by send
    #[arg(value_name = "MSGID")]
    pub message_id: String,
}

#[derive(Debug, Args)]
#[command(about = "Output the agent-facing workflow manual")]
pub struct PrimeArgs {
    /// Output the manual prelude without the generated command reference
    #[arg(long)]
    pub prelude: bool,
}

pub fn build_cli() -> Command {
    Cli::command().after_help(crate::prime::root_after_help())
}
