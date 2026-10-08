"use strict";

/*
 * Two shell-owned secrets, kept in the Router data dir:
 *
 *   machine secret   wraps the wallet session, so the wallet stays unlocked
 *                    across restarts without a prompt (Core's sessionSecret).
 *   wallet password  the keystore password. The user never sees or types it
 *                    (MVP_SPEC §6.5); the recovery key is their backup.
 *
 * Both are random and stored encrypted with Electron's safeStorage (the macOS
 * Keychain holds the key). When safeStorage is unavailable the value goes to a
 * 0600 plaintext file instead, with a logged warning: a wallet nobody can
 * unlock is worse than a key file only this user can read.
 *
 * safeStorage is injected so every path here runs in plain Node tests.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MACHINE_SECRET = "machine-secret";
const WALLET_PASSWORD = "wallet-password";
const ENCRYPTED_EXT = ".bin";
const PLAINTEXT_EXT = ".plain";

function defaultSafeStorage() {
  try {
    return require("electron").safeStorage || null;
  } catch {
    return null;
  }
}

function encryptionAvailable(safeStorage) {
  try {
    return !!safeStorage && safeStorage.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    // The mode above is filtered by umask; make sure it is exactly 0600.
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Read the named secret, creating it on first use. Returns the secret string,
 * or null when a stored secret exists but cannot be read right now (Keychain
 * locked or access denied). A stored secret is never overwritten: replacing
 * the wallet password would lock the wallet for good.
 */
function loadSecret({ dataDir, name, safeStorage = defaultSafeStorage(), log = console.warn, generate = randomSecret }) {
  if (!dataDir) throw new TypeError("loadSecret needs a dataDir");
  const encFile = path.join(dataDir, name + ENCRYPTED_EXT);
  const plainFile = path.join(dataDir, name + PLAINTEXT_EXT);
  const canEncrypt = encryptionAvailable(safeStorage);

  const encrypted = readIfExists(encFile);
  if (encrypted) {
    if (!canEncrypt) {
      log(`[secrets] ${name}: stored encrypted but safeStorage is unavailable; not readable this run`);
      return null;
    }
    try {
      return safeStorage.decryptString(encrypted);
    } catch (e) {
      log(`[secrets] ${name}: could not decrypt (${e.message})`);
      return null;
    }
  }

  const plain = readIfExists(plainFile);
  if (plain) {
    const value = plain.toString("utf8").trim();
    if (!value) return null;
    // safeStorage came back (or was never there before): move the secret into
    // it, and only drop the plaintext copy once the encrypted one is written.
    if (canEncrypt) {
      try {
        writePrivate(encFile, safeStorage.encryptString(value));
        fs.rmSync(plainFile, { force: true });
      } catch (e) {
        log(`[secrets] ${name}: could not migrate to safeStorage (${e.message})`);
      }
    }
    return value;
  }

  const value = generate();
  if (canEncrypt) {
    writePrivate(encFile, safeStorage.encryptString(value));
  } else {
    log(`[secrets] ${name}: safeStorage unavailable; storing it in a 0600 file instead`);
    writePrivate(plainFile, value + "\n");
  }
  return value;
}

function randomSecret() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * true when a secret is already stored encrypted in dataDir: reading it will
 * need the Keychain (and may make macOS ask). Creating one never asks.
 */
function hasEncryptedSecrets(dataDir, names = [MACHINE_SECRET, WALLET_PASSWORD]) {
  if (!dataDir) return false;
  return names.some((name) => {
    try {
      return fs.statSync(path.join(dataDir, name + ENCRYPTED_EXT)).size > 0;
    } catch {
      return false;
    }
  });
}

function machineSecret(dataDir, opts = {}) {
  return loadSecret({ ...opts, dataDir, name: MACHINE_SECRET });
}

function walletPassword(dataDir, opts = {}) {
  return loadSecret({ ...opts, dataDir, name: WALLET_PASSWORD });
}

module.exports = {
  machineSecret,
  walletPassword,
  loadSecret,
  randomSecret,
  hasEncryptedSecrets,
  MACHINE_SECRET,
  WALLET_PASSWORD,
  ENCRYPTED_EXT,
  PLAINTEXT_EXT,
};
