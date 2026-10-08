# Koinos Router

<p>
  <img src="docs/main-window.png" alt="Koinos Router main window: balance, Share compute and Use KoinosAI switches" width="420">
  &nbsp;
  <img src="docs/menu-bar.png" alt="Koinos Router menu-bar popover: balance, today's earned and spent, both switches" width="210">
</p>

Koinos Router is a macOS menu-bar app with two switches:

- **Share compute** earns KAI by serving Koinos Network jobs while your Mac is idle.
- **Use KoinosAI** lets Codex and Claude Code hand small text jobs (summarize a log, classify
  items, extract fields, convert formats, draft boilerplate) to cheaper network models, paid in KAI.
  Router adds one MCP tool, `delegate`, to each harness. The agent decides when to use it.

It is built on KoinosAI Core from this repo (the `router` profile of `createCore`). The full
KoinosAI app is unchanged. Apple Silicon only.

More detail: `docs/MVP_SPEC.md` (what it does and why) and `router/ARCHITECTURE.md` (module
contracts, exact copy, HTTP surface).

## Run from source

You need macOS on Apple Silicon and Node.js 22 or later (the test scripts use `node --test` with
glob patterns, which Node 20 doesn't support).

```sh
npm install
npm run router
```

This starts the real app, against the live network (koinosai.com). Know before you run it:

- It uses the same data folder as an installed Koinos Router
  (`~/Library/Application Support/Koinos Router`). If Router is already running, the second copy
  just brings the first one forward and exits.
- **Connect** edits your real `~/.codex/config.toml` and `~/.claude.json`.
- The Electron binary in `node_modules` is a different app to the Keychain than an installed
  build, so switching between the two brings up the Keychain prompt described below.

To run a separate copy that leaves your real Router and harness configs alone, point it at temp
folders:

```sh
KOINOS_ROUTER_DATA="$(mktemp -d)" KOINOS_ROUTER_HARNESS_HOME="$(mktemp -d)" npm run router
```

If port 41110 is taken, Router listens on a port the OS picks. Use the local demo below to keep
it off the live network too.

Headless check that everything boots (fresh temp data folder, removed on exit; prints
`SMOKE OK <port>` and exits 0):

```sh
npm run router:smoke
```

In scripts and CI, start Router only with `--smoke` or with a temp `KOINOS_ROUTER_DATA`: a normal
run uses your real wallet and data.

## Local demo (fake network)

```sh
npm run router:demo            # reuse the demo profile from last time
npm run router:demo -- --fresh # start over: new wallet, first-run screens
```

(`node router/scripts/local-demo.js [--fresh]` is the same thing.)

The demo runs the real app against a private stand-in for the network, so you can click through
onboarding, both switches, Start now, Activity and Settings without a live wallet, without
registering with koinosai.com, and without downloading a model.

- **Fake:** the scheduler (the in-repo fixture `server/scheduler.js`, on a random local port) and
  the model server (`core/test/fixtures/fake-llama-server`, which answers every prompt with
  "Hello from fake llama"). Sharing is pinned to the tiny `dev-tiny` model with a placeholder
  file, so nothing downloads.
- **Real:** the Electron shell, Core, the Router service, the MCP endpoint, the ledger, the idle
  policy, and the Keychain-backed secrets.
- **Sandboxed harness home:** `KOINOS_ROUTER_HARNESS_HOME` points at
  `$TMPDIR/koinos-router-demo/harness-home`, which has empty `.codex` and `.claude` folders so both
  tools show as found. Connect writes there, never to your real `~/.codex` or `~/.claude.json`.
  After Connect, `harness-home/.codex/config.toml` shows exactly what Router writes, including the
  MCP URL.
- The profile lives in `$TMPDIR/koinos-router-demo` (`core/` is the data folder). It has its own
  Electron profile, so it can run next to an installed Router.

Want to work on the pages without Electron or Core at all? `node router/ui/dev-mock.js` serves
them with an in-memory API at http://127.0.0.1:41190 (add `?scenario=earning`, `waiting`,
`paused`, `outofkai`, `preparing`, `firstrun` or `notools`).

## Build

```sh
npm run dist:router
```

Output: `dist-router/Koinos-Router-<version>-arm64.dmg` and `.zip` (the app itself is in
`dist-router/mac-arm64/`). Extra arguments go to electron-builder (`npm run dist:router -- --dir`
builds only the app). The build is configured in `router/electron-builder.yml`: menu-bar only
(`LSUIElement`), hardened runtime, Electron fuses that stop anything else running code inside the
app (no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`; only the integrity-checked
`app.asar` loads), and no update feed.

`dist:router` signs the app with the best code-signing identity in your keychain, in this order:
`KOINOS_ROUTER_SIGN_IDENTITY` if you set it (a name or SHA-1; `-` means ad-hoc), a Developer ID
Application, an Apple Development identity, the local "Koinos Router Local" identity (below), or
none (ad-hoc). It prints which one it used.

## The Keychain prompt, and signing

Router keeps two random secrets (the wallet password and a session secret) encrypted with
Electron's `safeStorage`. The key for that lives in your login Keychain as
**"Koinos Router Safe Storage"**, and the Keychain only hands it to the build it trusted last.

| Build signed with | Keychain prompt |
|---|---|
| nothing (ad-hoc) | on the first launch of **every new build** |
| Apple Development or Developer ID (has an Apple team ID) | once; "Always Allow" survives rebuilds |
| the local "Koinos Router Local" identity | the same identity every build, but no team ID, so macOS may still ask once after a rebuild |

The very first install never asks: creating the key doesn't. A build copied to another Mac is new
to that Mac's Keychain too.

Router tells you before macOS asks: a packaged build whose signature differs from the one that last
opened the key shows "One quick permission" first. Enter your Mac login password in the macOS
dialog that follows and choose "Always Allow". If you choose Deny, Router shows "Wallet locked":
Try Again relaunches Router so macOS asks again; Not Now runs with the wallet locked (no sharing or
spending; the Share row says "Wallet locked · Restart Router") until the next launch.

Fewest prompts: sign with an **Apple Development** certificate. It is free with an Apple ID (Xcode ›
Settings › Accounts › Manage Certificates) and `dist:router` picks it up by itself.

No Apple ID handy? Make the local identity once, then rebuild:

```sh
npm run router:setup-signing     # same as: bash router/scripts/setup-dev-signing.sh
npm run dist:router
```

The script makes a self-signed code-signing certificate, "Koinos Router Local", in your login
keychain (only `/usr/bin/codesign` may use its key; no trust settings change). macOS asks for your
login keychain password once while it sets this up. Running it again changes nothing. To remove
it: Keychain Access › login › My Certificates › delete "Koinos Router Local" with its private key.
Check what a build was signed with:
`codesign -dv --verbose=2 "dist-router/mac-arm64/Koinos Router.app"` (look at `Authority` and
`TeamIdentifier`).

None of this helps on other Macs. Until Router has a Developer ID and is notarized, a build copied
to another Mac needs System Settings › Privacy & Security › Open Anyway on first open. A Developer
ID, notarization and updates in place are planned (MVP_SPEC §9, M4).

## Where data lives

| What | Where |
|---|---|
| Electron profile | `~/Library/Application Support/Koinos Router/` |
| Router data | `~/Library/Application Support/Koinos Router/core/` |
| — settings, switches, MCP token | `core/settings.json` |
| — activity (30 days) | `core/router-ledger.jsonl` (+ `.day.json`) |
| — wallet keystore and session | `core/wallet/` (an older keystore is kept as `wallet.json.bak-<time>` after a restore) |
| — wallet password, session secret | `core/wallet-password.bin`, `core/machine-secret.bin` (encrypted; key in the Keychain) |
| — model and engine downloads | `core/models/`, `core/runtimes/` |
| — which build last opened the Keychain key | `core/keychain-access.json` |
| — log | `core/core.log` |
| Keychain | login keychain item "Koinos Router Safe Storage" |
| Codex config | `~/.codex/config.toml` (`[mcp_servers.koinos]`), skill in `~/.codex/skills/koinos-delegate/` |
| Claude Code config | `~/.claude.json` (`mcpServers.koinos`), skill in `~/.claude/skills/koinos-delegate/` |
| Your original harness configs | `config.toml.koinos-router.bak`, `.claude.json.koinos-router.bak` (made once, before Router's first change) |

With `KOINOS_ROUTER_DATA=<dir>`, Router data goes to `<dir>` and the Electron profile to
`<dir>/electron`. With `KOINOS_ROUTER_HARNESS_HOME=<dir>`, the harness files above are under
`<dir>` instead of your home folder.

The wallet's recovery key is the only way to move your balance to another Mac or get it back.
Settings › Wallet › Back up shows it after Touch ID or your Mac login password. Keep it somewhere
private. On a new Mac, use "I already use Koinos Router on another Mac" on the Welcome screen.

To remove Router: back up the recovery key, disconnect Codex and Claude Code in Settings (this
removes the `koinos` entries and the skills), quit Router, then delete the app, the data folder
above and the Keychain item.

## Using it with Codex and Claude Code

1. Turn on **Use KoinosAI** (onboarding does it for you).
2. Connect Codex and/or Claude Code (Welcome › Connect your tools, or Settings).
3. Start a new Codex or Claude Code session so it loads the `koinos` server.

The agent calls `delegate` with a task and, for large input, absolute file paths, which Router
reads itself. Router refuses files that look private (`.env`, keys, `.ssh/`, `~/Library`, its own
data) and anything containing what looks like a secret, and tells the agent why. Answers come
back wrapped in `<untrusted_output>`, with a footer like `[koinos · koinos-smart · 0.03 KAI ·
2 chunks]`. On any error the tool tells the agent to do the task itself. The daily limit (default
10 KAI) is in Settings.

## Tests

```sh
npm run test:router   # Router suites only (about 375 tests)
npm test              # Core and Router
```

`npm test` has 6 known failures that come from the environment, not from Router: 5 in
`core/test/node-data-folder.browser.test.js` (no Chromium at `/opt/pw-browsers`) and 1 in
`core/test/ollama.test.js`. Router tests use temp folders, the in-repo scheduler fixture and a
fake model server. They never touch your home folder, harness configs, login keychain or the live
network.

## Known limitations

- Apple Silicon, macOS 12 or later. No Developer ID yet: unless you sign with an Apple
  Development identity, expect a Keychain prompt after each rebuild; other Macs need Open Anyway;
  no automatic updates.
- The network today: 4,096-token context, answers of at most 512 tokens per part, text only, and
  one request at a time per wallet. A delegation can use at most 8 parts and takes up to 180 s.
- KAI is testnet. It has no cash value.
- One Mac per wallet should share compute. Router turns Share off after you restore a wallet, but
  it doesn't detect or stop a second Mac sharing on the same wallet; if both share, they knock
  each other off.
- "Earned today" is an estimate: any balance increase since Router's first balance read that day
  (a deposit too). Shared-compute rows in Activity have no KAI amount. "Spent today" is priced at
  published rates; the free daily allowance is used first, so your balance may drop by less.
- "Connected" means the harness config points at Router. Router doesn't call the tool itself to
  check, and a harness only sees a new connection in a new session.
- The model server runs at below-normal priority but has no thread cap.
- Anyone running a Share worker can read the tasks sent to them. The secret guard is
  pattern-based and can miss a secret in an unusual format, so don't delegate private code or data.
- The MCP URL, including its token, is stored in plain text in the harness configs; any program
  running as you can read it and spend KAI through `delegate`, within the daily limit.
- Restoring a recovery key is only offered on the Welcome screen.
