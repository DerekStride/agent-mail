#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <version> <arm64_sha256> <x86_64_sha256>" >&2
  exit 1
fi

version="$1"
arm_sha="$2"
intel_sha="$3"

cat <<EOF
class AgentMail < Formula
  desc "Local Maildir message bus for coding agents"
  homepage "https://github.com/DerekStride/agent-mail"
  version "${version}"
  license "MIT"

  on_arm do
    url "https://github.com/DerekStride/agent-mail/releases/download/v#{version}/agent-mail-v#{version}-aarch64-apple-darwin.tar.gz"
    sha256 "${arm_sha}"
  end

  on_intel do
    url "https://github.com/DerekStride/agent-mail/releases/download/v#{version}/agent-mail-v#{version}-x86_64-apple-darwin.tar.gz"
    sha256 "${intel_sha}"
  end

  def install
    bin.install "agent-mail"
  end

  test do
    root = testpath/"mail"
    ENV["AGENT_MAIL_ROOT"] = root.to_s
    output = shell_output("#{bin}/agent-mail send --to receiver --from sender --body hello")
    assert_match /T/, output
    assert_match "Subject: (no subject)", shell_output("#{bin}/agent-mail read #{output.strip}")
  end
end
EOF
