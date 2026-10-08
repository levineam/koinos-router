"use strict";

/*
 * Router keeps its machine secret and wallet password with Electron's
 * safeStorage, whose key is one login-keychain item ("Koinos Router Safe
 * Storage"). macOS lets an app read that item without asking only while the
 * app is the one it trusted last time. A new build that macOS sees as a
 * different app gets a system dialog ("Koinos Router wants to use your
 * confidential information...") at boot, and safeStorage blocks Router's main
 * process until it is answered: Router looks frozen and nothing says why.
 *
 * So before the first decrypt, the shell asks this module whether macOS is
 * about to ask, and if so explains it first in a dialog of its own.
 *
 * Which builds macOS treats as "the same app" for that item:
 *   - The item's ACL trusts an app by its designated requirement (DR). An
 *     ad-hoc build's DR is its cdhash, so every rebuild is a stranger; a
 *     certificate-signed build's DR names the identifier and certificate, so
 *     it survives rebuilds.
 *   - Login-keychain items also carry a partition list. securityd files code
 *     signed by an Apple-issued certificate (Developer ID, Apple Development)
 *     under "teamid:<team>", which survives rebuilds; anything else
 *     (ad-hoc, a self-signed certificate) under "cdhash:<hash>", which does
 *     not. So without a team ID a changed cdhash means a prompt too.
 * The identity recorded here is therefore the DR, plus the cdhash when the
 * build has no team ID.
 *
 * Everything here is plain Node: execFile is injected, the shell owns the
 * dialogs.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CODESIGN = "/usr/bin/codesign";
const CODESIGN_TIMEOUT_MS = 3000;
const RECORD_FILE = "keychain-access.json";

// What the person reads before macOS asks (title, message, detail, button).
const EXPLAIN = Object.freeze({
  title: "One quick permission",
  message: "macOS will ask if Koinos Router can use its saved key",
  detail:
    "Koinos Router was updated, so macOS checks again before Router can open the key it saved in your keychain.\n\n" +
    "When macOS asks, enter your Mac login password and choose “Always Allow” (or “Allow” if that’s all you see).\n\n" +
    "This lets Router unlock your wallet and keep earning without asking each time.",
  button: "Continue",
});

// What the person reads when the key stayed shut (Deny, or the dialog failed).
const DENIED = Object.freeze({
  title: "Wallet locked",
  message: "Koinos Router couldn’t open its saved key",
  detail:
    "macOS didn’t let Router use the key it keeps in your keychain, so your wallet stays locked: " +
    "Router can’t earn or spend KAI until it can open it.\n\n" +
    "Choose Try Again, then enter your Mac login password and choose “Always Allow” when macOS asks.",
  buttons: ["Try Again", "Not Now"],
});

/** "/X.app/Contents/MacOS/X" → "/X.app"; null when not inside an app bundle. */
function bundlePathFromExecPath(execPath) {
  if (typeof execPath !== "string" || !execPath) return null;
  const macos = path.dirname(execPath);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== "MacOS" || path.basename(contents) !== "Contents") return null;
  if (!bundle.endsWith(".app")) return null;
  return bundle;
}

/**
 * Parse `codesign -d -vvv -r- <bundle>` output (the DR goes to stdout, the
 * rest to stderr; both are searched). → { designated, cdhash, teamId } with
 * null for anything missing; designated null means unusable.
 */
function parseCodesignDisplay(stdout = "", stderr = "") {
  const text = `${stdout}\n${stderr}`;
  const dr = /^(?:#\s*)?designated\s*=>\s*(.+?)\s*$/m.exec(text);
  const cdhash = /^CDHash=([0-9a-f]+)\s*$/im.exec(text);
  const team = /^TeamIdentifier=(.+?)\s*$/m.exec(text);
  const teamId = team && team[1] !== "not set" ? team[1] : null;
  return {
    designated: dr ? dr[1] : null,
    cdhash: cdhash ? cdhash[1].toLowerCase() : null,
    teamId,
  };
}

/**
 * The bundle's signing identity, or null when codesign fails, times out or
 * prints no designated requirement. Never rejects: boot must not wait on it.
 */
function readSigningIdentity({ bundlePath, execFile, timeoutMs = CODESIGN_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    if (!bundlePath || typeof execFile !== "function") return resolve(null);
    try {
      execFile(
        CODESIGN,
        ["-d", "-vvv", "-r-", bundlePath],
        { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return resolve(null);
          const id = parseCodesignDisplay(String(stdout || ""), String(stderr || ""));
          resolve(id.designated ? id : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * What must stay the same for macOS not to ask again: the DR, plus the cdhash
 * when there is no team ID (see the top of this file). null when unusable.
 */
function identityKey(id) {
  if (!id || typeof id.designated !== "string" || !id.designated) return null;
  if (id.teamId) return `designated:${id.designated}`;
  return `designated:${id.designated}\ncdhash:${id.cdhash || ""}`;
}

/**
 * Should Router explain the Keychain prompt before its first decrypt?
 *   packaged  app.isPackaged (a checkout runs the stock Electron binary)
 *   smoke     smoke runs never touch the real keychain
 *   hasSecrets  an encrypted secret already exists (none: nothing to decrypt,
 *             and creating the key never prompts)
 *   current   this build's identity, or null when codesign failed
 *   recorded  the identity recorded after the last successful decrypt, or null
 * A codesign failure explains only when there is a record to go by: unsure
 * whether this build is the trusted one, say what may come; with no record
 * either, there is nothing to compare and a broken codesign would make Router
 * explain at every launch.
 */
function shouldExplainKeychain({ packaged, smoke, hasSecrets, current, recorded }) {
  if (!packaged || smoke || !hasSecrets) return false;
  const was = identityKey(recorded);
  if (!current) return was !== null;
  const now = identityKey(current);
  if (now === null) return was !== null;
  return was === null || was !== now;
}

function recordPath(dataDir) {
  return path.join(dataDir, RECORD_FILE);
}

/** The recorded identity, or null (missing, unreadable, or not ours). */
function readRecord(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(recordPath(dataDir), "utf8"));
    if (!raw || typeof raw.designated !== "string" || !raw.designated) return null;
    return {
      designated: raw.designated,
      cdhash: typeof raw.cdhash === "string" ? raw.cdhash : null,
      teamId: typeof raw.teamId === "string" && raw.teamId ? raw.teamId : null,
    };
  } catch {
    return null;
  }
}

/** Record the identity macOS just let decrypt (0600, atomic). → true when written. */
function writeRecord(dataDir, id, now = () => Date.now()) {
  if (!identityKey(id)) return false;
  const file = recordPath(dataDir);
  const body = JSON.stringify({ designated: id.designated, cdhash: id.cdhash || null, teamId: id.teamId || null, at: now() }, null, 2) + "\n";
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Same identity as far as the Keychain is concerned. */
function sameIdentity(a, b) {
  const ka = identityKey(a);
  return ka !== null && ka === identityKey(b);
}

module.exports = {
  bundlePathFromExecPath,
  parseCodesignDisplay,
  readSigningIdentity,
  identityKey,
  shouldExplainKeychain,
  readRecord,
  writeRecord,
  sameIdentity,
  EXPLAIN,
  DENIED,
  CODESIGN,
  CODESIGN_TIMEOUT_MS,
  RECORD_FILE,
};
