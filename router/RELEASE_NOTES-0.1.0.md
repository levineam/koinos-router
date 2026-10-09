# Koinos Router 0.1.0

First test release of Koinos Router, a menu-bar app for Apple Silicon Macs built on KoinosAI Core
0.54.12. It has two switches:

- **Share compute** earns KAI by serving Koinos Network jobs while your Mac is idle.
- **Use KoinosAI** lets Codex and Claude Code hand small text jobs (summarize a log, classify, extract
  fields, convert formats, draft boilerplate) to network models, paid in KAI. Router adds one MCP
  tool, `delegate`; the agent decides when to use it.

## Install

1. Download `Koinos-Router-0.1.0-arm64.dmg` below (or the `.zip`; checksums in `SHA256SUMS.txt`).
2. Open the DMG, drag **Koinos Router** onto **Applications**, and open it from Applications.
3. **macOS blocks the first open**, because this build isn't signed with a Developer ID or
   notarized. Click **Done**, go to **System Settings › Privacy & Security**, scroll to
   **Security** and click **Open Anyway** next to Koinos Router, then confirm with your password.
   Or in Terminal: `xattr -dr com.apple.quarantine "/Applications/Koinos Router.app"`
4. Click **Get started**, connect Codex and/or Claude Code, then **Done**. Router makes its own
   wallet and Keychain item, so a fresh install asks for no password. Start a new Codex or Claude
   Code session so it sees the `koinos` tool. Back up your recovery key (Settings › Wallet).

Full guide, including uninstall: https://github.com/levineam/koinos-router/blob/main/router/README.md#download

## Known limitations

- Not signed with a Developer ID or notarized: each version you download needs Open Anyway once,
  and after an update macOS asks once for your login password so the new version can use Router's
  saved key (Router explains first; choose Always Allow). No automatic updates: Router shows
  "Update available" with a link to the new release.
- Apple Silicon (M1 or later) and macOS 12+ only. KAI is testnet and has no cash value.
- One sharing Mac per wallet: a wallet can spend from several Macs, but two sharing Macs knock
  each other off. Turn on Share compute on only one.
- Delegation is for small, text-only tasks: about 4,000 tokens per part, at most 8 parts, short
  answers, up to 3 minutes, no tool use.
- Delegated tasks can be read by the volunteer whose Mac runs them. Router blocks files that look
  private (`.env`, keys, `.ssh/`, `~/Library`) and anything that looks like a secret, but the check
  is pattern-based: don't delegate private code.
- The first Share downloads the engine and a model of about 2.5 GB. A laptop shares only when
  plugged in and idle for 5 minutes by default (Start now and Settings change that).

## Feedback

Open an issue at https://github.com/levineam/koinos-router/issues with your Mac model, macOS version,
what you did and what happened. Log: `~/Library/Application Support/Koinos Router/core/core.log`.
