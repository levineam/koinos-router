#!/bin/bash
#
# Koinos Router: a stable code-signing identity for local builds.
#
# Why: `npm run dist:router` without an identity makes an ad-hoc signed app,
# whose identity (its "designated requirement") is a hash of the build. Every
# rebuild is a new app to macOS, so the Keychain asks again for "Koinos Router
# Safe Storage" and "Always Allow" never sticks. Signing every build with the
# same certificate keeps the designated requirement the same from one build
# to the next, so the item's access list keeps trusting Router.
#
# Limit: login-keychain items also have a partition list, and macOS files
# code signed without an Apple team ID (ad-hoc or self-signed) under its
# cdhash, which still changes per build; so macOS may still ask once after a
# rebuild. An Apple Development or Developer ID certificate has a team ID and
# avoids that; router/scripts/sign-router.js prefers one when present.
#
# What it does (once; running it again changes nothing):
#   1. makes a self-signed code-signing certificate named "Koinos Router Local"
#      (10 years, RSA 2048, made locally with openssl, never uploaded anywhere),
#   2. imports it with its private key into your login keychain, letting only
#      /usr/bin/codesign use the key,
#   3. lets codesign use it without a prompt on every build (macOS asks for
#      your login keychain password once for this).
#
# It does not change any trust settings: macOS will report the certificate as
# "not trusted", which is fine. Code signed with it is for this Mac only.
#
# Run it yourself, in Terminal, from the repo root:
#   bash router/scripts/setup-dev-signing.sh
# then rebuild with `npm run dist:router`.
#
# To remove it later: Keychain Access › login › My Certificates › delete
# "Koinos Router Local" (with its private key).
#
# KOINOS_SIGN_KEYCHAIN=/path/to/other.keychain-db uses that keychain instead
# of the login keychain (the test suite uses a throwaway keychain this way);
# KOINOS_SIGN_KEYCHAIN_PASSWORD then unlocks it without a prompt.

set -euo pipefail

NAME="${KOINOS_SIGN_IDENTITY:-Koinos Router Local}"
KEYCHAIN="${KOINOS_SIGN_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
OPENSSL=/usr/bin/openssl

say() { printf '%s\n' "$*"; }
fail() { printf 'setup-dev-signing: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this is for macOS only."
[ -x "$OPENSSL" ] || fail "$OPENSSL is missing."
[ -f "$KEYCHAIN" ] || fail "no keychain at $KEYCHAIN"

# The identity's SHA-1 when it exists in KEYCHAIN (valid or not: a
# self-signed certificate is never "valid", and that is expected).
identity_hash() {
  security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null |
    awk -v name="\"$NAME\"" 'index($0, name) && $2 ~ /^[0-9A-F]{40}$/ { print $2; exit }'
}

existing="$(identity_hash || true)"
if [ -n "$existing" ]; then
  say "Already set up: \"$NAME\" ($existing) is in $KEYCHAIN."
  say "Nothing changed. Build with: npm run dist:router"
  exit 0
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/koinos-signing.XXXXXX")"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
chmod 700 "$work"

say "Creating the code-signing certificate \"$NAME\"..."
cat > "$work/cert.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $NAME
O = Koinos Router local build
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -config "$work/cert.cnf" -keyout "$work/key.pem" -out "$work/cert.pem" >/dev/null 2>&1 ||
  fail "openssl could not create the certificate."

# A one-time password just for carrying the key into the keychain.
p12pass="$("$OPENSSL" rand -hex 24)"
legacy=()
if "$OPENSSL" version | grep -q '^OpenSSL 3'; then legacy=(-legacy); fi
"$OPENSSL" pkcs12 -export ${legacy[@]+"${legacy[@]}"} -inkey "$work/key.pem" -in "$work/cert.pem" \
  -name "$NAME" -passout "pass:$p12pass" -out "$work/identity.p12" >/dev/null 2>&1 ||
  fail "openssl could not package the certificate."

if [ -n "${KOINOS_SIGN_KEYCHAIN_PASSWORD:-}" ]; then
  security unlock-keychain -p "$KOINOS_SIGN_KEYCHAIN_PASSWORD" "$KEYCHAIN"
fi

say "Importing it into $KEYCHAIN (only codesign may use the key)..."
security import "$work/identity.p12" -k "$KEYCHAIN" -f pkcs12 -P "$p12pass" -T /usr/bin/codesign >/dev/null ||
  fail "security import failed."

# Without the next two steps, macOS asks "codesign wants to sign using key
# ..." at the first build (Always Allow there works too). `security import`
# labels every key "Imported Private Key", and set-key-partition-list can
# only pick keys by label, so first give this key its own label: it is found
# by its public-key hash (the certificate's subject key identifier), which
# no other key has. Only then is the partition list set, for that one key.
ski="$("$OPENSSL" x509 -in "$work/cert.pem" -noout -text |
  awk '/Subject Key Identifier/ { getline; gsub(/[ :]/, ""); print; exit }')"
relabeled=no
if [ -n "$ski" ]; then
  ski64="$(printf '%s' "$ski" | xxd -r -p | base64)"
  cat > "$work/relabel.js" <<'JXA'
ObjC.import("Foundation");
ObjC.import("Security");
function run(argv) {
  // kSecClass=class, kSecClassKey=keys, kSecAttrKeyClass=kcls (1 = private),
  // kSecAttrApplicationLabel=klbl, kSecAttrLabel=labl
  const query = $.NSMutableDictionary.dictionary;
  query.setObjectForKey($("keys"), $("class"));
  query.setObjectForKey($("1"), $("kcls"));
  query.setObjectForKey($.NSData.alloc.initWithBase64EncodedStringOptions($(argv[0]), 0), $("klbl"));
  const attrs = $.NSMutableDictionary.dictionary;
  attrs.setObjectForKey($(argv[1]), $("labl"));
  return String($.SecItemUpdate(query, attrs));
}
JXA
  if [ "$(osascript -l JavaScript "$work/relabel.js" "$ski64" "$NAME" 2>/dev/null)" = "0" ]; then relabeled=yes; fi
fi

if [ "$relabeled" = yes ]; then
  say "Letting codesign use the key without asking each build."
  if [ -n "${KOINOS_SIGN_KEYCHAIN_PASSWORD:-}" ]; then
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -t private -l "$NAME" \
      -k "$KOINOS_SIGN_KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null ||
      say "Skipped. The first build will ask instead: choose Always Allow there."
  else
    say "macOS asks for your login keychain password now (normally your Mac login password)."
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -t private -l "$NAME" "$KEYCHAIN" >/dev/null ||
      say "Skipped. The first build will ask instead: choose Always Allow there."
  fi
else
  say "The first build will ask \"codesign wants to sign using key...\": enter your password and choose Always Allow."
fi

hash="$(identity_hash || true)"
[ -n "$hash" ] || fail "the identity did not show up in $KEYCHAIN."

say ""
say "Done. \"$NAME\" ($hash) is ready."
say "Next:"
say "  1. npm run dist:router    (signs Koinos Router with this identity)"
say "  2. Open the new Koinos Router. Router says first that macOS will ask"
say "     about \"Koinos Router Safe Storage\": enter your Mac login password"
say "     and choose Always Allow."
say ""
say "Every later build keeps this same signing identity. A self-signed"
say "certificate has no Apple team ID, though, and macOS may still ask once"
say "after a rebuild (Router explains it first when it does). An Apple"
say "Development certificate (free: Xcode > Settings > Accounts > Manage"
say "Certificates > +) has a team ID; dist:router prefers it when present."
