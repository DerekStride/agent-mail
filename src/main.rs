mod cli;
mod mail;
mod prime;

use anyhow::Result;
use clap::Parser;

fn main() {
    if let Err(error) = run() {
        eprintln!("agent-mail: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = cli::Cli::parse();

    match cli.command {
        cli::Commands::Send(args) => mail::send(&args),
        cli::Commands::Scan(args) => mail::scan(&args),
        cli::Commands::Read(args) => mail::read(&args),
        cli::Commands::Receipt(args) => mail::receipt(&args),
        cli::Commands::Prime(args) => prime::execute(&args),
    }
}
