#!/usr/bin/env sh
#
# deckrun - one-command installer for Linux & macOS
#
#   curl -fsSL https://raw.githubusercontent.com/arpitbbhayani/deckrun/master/install.sh | sh
#
# Installs deckrun globally from npm. If Node.js (>= 16) is missing or too
# old, it downloads an LTS Node.js into ~/.local/share/deckrun-node (no root
# required), puts it on PATH for this shell, and persists that PATH entry in
# your shell profile so deckrun keeps working in future terminals.
#
# Windows users: see install.ps1  (irm ... | iex)

set -eu

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

say()  { printf "%b\n" "$1"; }
info() { say "${CYAN}deckrun${RESET} $1"; }
ok()   { say "${GREEN}✓${RESET} $1"; }
warn() { say "${YELLOW}!${RESET} $1"; }

# ── Configuration ─────────────────────────────────────────────────────────
NODE_MIN_MAJOR=16
# LTS to install when Node is missing or too old. Override with the
# DECKRUN_NODE_VERSION environment variable, e.g. DECKRUN_NODE_VERSION=20.
NODE_MAJOR="${DECKRUN_NODE_VERSION:-22}"
NODE_INSTALL_DIR="${DECKRUN_NODE_DIR:-$HOME/.local/share/deckrun-node}"
DOWNLOAD_URL="https://nodejs.org/dist"

# ── Tools ─────────────────────────────────────────────────────────────────
DOWNLOAD_SH=""
if command -v curl >/dev/null 2>&1; then
  DOWNLOAD_SH="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOAD_SH="wget -qO-"
fi

# Persist a PATH entry across future shells without duplicating it.
#
# Appended rather than prepended, and written to one profile file rather than
# four: prepending a user-writable directory to PATH in every shell means
# anything that later lands in it shadows the system binary of the same name,
# everywhere, forever.
persist_path() {
  key="$NODE_INSTALL_DIR/bin"
  rc=""
  for candidate in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$candidate" ]; then rc="$candidate"; break; fi
  done
  if [ -z "$rc" ]; then rc="$HOME/.profile"; fi
  if [ -f "$rc" ] && grep -qF "$key" "$rc" 2>/dev/null; then
    return 0
  fi
  printf '\n# added by the deckrun installer\nexport PATH="$PATH:%s"\n' "$key" >> "$rc"
  info "Added $key to PATH in $rc."
}

# Refuse an install directory that is not a sane absolute path under $HOME.
#
# The contents of this directory are deleted before the new Node is unpacked,
# and the path comes from DECKRUN_NODE_DIR with no validation at all.
validate_install_dir() {
  case "$NODE_INSTALL_DIR" in
    /) warn "DECKRUN_NODE_DIR must not be /."; exit 1 ;;
    /*) : ;;
    *) warn "DECKRUN_NODE_DIR must be an absolute path (got '$NODE_INSTALL_DIR')."; exit 1 ;;
  esac
  case "$NODE_INSTALL_DIR" in
    "$HOME"/?*) : ;;
    *) warn "DECKRUN_NODE_DIR must be a path under $HOME (got '$NODE_INSTALL_DIR')."; exit 1 ;;
  esac
  case "$NODE_INSTALL_DIR" in
    *..*) warn "DECKRUN_NODE_DIR must not contain '..'."; exit 1 ;;
  esac
}

# Verify a downloaded file against the checksums Node publishes per release.
#
# HTTPS covers the network hop and nothing else: it is no defence against a
# compromised or cached artifact, and without this there is no way for anyone
# to notice tampering after the fact.
verify_checksum() {
  dir="$1"
  name="$2"
  version="$3"

  if [ "$DOWNLOAD_SH" = "curl -fsSL" ]; then
    curl -fsSL "$DOWNLOAD_URL/$version/SHASUMS256.txt" -o "$dir/SHASUMS256.txt"
  else
    wget -qO "$dir/SHASUMS256.txt" "$DOWNLOAD_URL/$version/SHASUMS256.txt"
  fi

  expected="$(grep -E "[[:space:]]\\*?$name\$" "$dir/SHASUMS256.txt" | awk '{print $1}' | head -n1)"
  if [ -z "$expected" ]; then
    warn "No checksum published for $name; refusing to install it."
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$dir/$name" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$dir/$name" | awk '{print $1}')"
  else
    warn "Neither sha256sum nor shasum is available; cannot verify the download."
    warn "Install Node.js >= $NODE_MIN_MAJOR from https://nodejs.org, then re-run."
    exit 1
  fi

  if [ "$actual" != "$expected" ]; then
    warn "Checksum mismatch for $name."
    warn "  expected $expected"
    warn "  actual   $actual"
    exit 1
  fi
  ok "Verified $name against SHASUMS256.txt."
}

# ── Auto-install Node.js for this platform ───────────────────────────────
install_node() {
  os="$(uname -s)"
  machine="$(uname -m)"

  case "$os" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *)      warn "Unsupported OS for automatic Node installation: $os"
            warn "Install Node.js >= $NODE_MIN_MAJOR from https://nodejs.org, then re-run."
            exit 1 ;;
  esac

  case "$machine" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l)        arch="armv7l" ;;
    *) warn "Unsupported architecture for automatic Node installation: $machine"
       warn "Install Node.js >= $NODE_MIN_MAJOR from https://nodejs.org, then re-run."
       exit 1 ;;
  esac

  if [ -z "$DOWNLOAD_SH" ]; then
    warn "Neither curl nor wget is available; cannot download Node.js."
    warn "Install Node.js >= $NODE_MIN_MAJOR from https://nodejs.org, then re-run."
    exit 1
  fi

  # Resolve the exact latest LTS patch for the chosen major from the index.
  index="$($DOWNLOAD_SH "$DOWNLOAD_URL/index.json")"
  version="$(
    printf '%s\n' "$index" |
      grep -oE '"version":"v'"$NODE_MAJOR"'\.[0-9]+\.[0-9]+"' |
      head -n1 |
      grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+'
  )"
  if [ -z "$version" ]; then
    warn "Could not resolve a Node.js v$NODE_MAJOR LTS version."
    warn "Install Node.js >= $NODE_MIN_MAJOR from https://nodejs.org, then re-run."
    exit 1
  fi

  # Linux ships .tar.xz; macOS ships .tar.gz.
  if [ "$os" = "linux" ]; then
    ext="tar.xz"
  else
    ext="tar.gz"
  fi

  validate_install_dir

  file="node-$version-$os-$arch.$ext"
  tmp="$(mktemp -d)"
  cleanup() { rm -rf "$tmp"; }
  trap cleanup EXIT

  info "Downloading Node.js $version ($os/$arch)…"
  if [ "$DOWNLOAD_SH" = "curl -fsSL" ]; then
    curl -fsSL "$DOWNLOAD_URL/$version/$file" -o "$tmp/$file"
  else
    wget -qO "$tmp/$file" "$DOWNLOAD_URL/$version/$file"
  fi

  verify_checksum "$tmp" "$file" "$version"

  mkdir -p "$NODE_INSTALL_DIR"
  if [ "$ext" = "tar.gz" ]; then
    tar -xzf "$tmp/$file" -C "$tmp"
  else
    tar -xJf "$tmp/$file" -C "$tmp"
  fi
  rm -rf "$NODE_INSTALL_DIR"/*
  cp -R "$tmp/node-$version-$os-$arch/"* "$NODE_INSTALL_DIR/"

  persist_path
  PATH="$NODE_INSTALL_DIR/bin:$PATH"
  export PATH
  ok "Node.js $version installed locally ($NODE_INSTALL_DIR)."
}

# ── Ensure Node.js >= NODE_MIN_MAJOR is available ────────────────────────
ensure_node() {
  has_node=0
  if command -v node >/dev/null 2>&1; then
    existing="$(node -v 2>/dev/null | sed 's/^v//')"
    major="$(printf '%s\n' "$existing" | sed 's/\..*$//')"
    if [ -n "$major" ] && [ "$major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; then
      has_node=1
      info "Node.js v$existing detected."
      return 0
    fi
    warn "Found Node.js v$existing; deckrun needs >= $NODE_MIN_MAJOR."
  fi

  # A previously auto-installed copy counts too even if the bare `node`
  # isn't on the live PATH yet (e.g. new shell, profile not yet sourced).
  if [ -x "$NODE_INSTALL_DIR/bin/node" ]; then
    existing="$("$NODE_INSTALL_DIR/bin/node" -v 2>/dev/null | sed 's/^v//')"
    major="$(printf '%s\n' "$existing" | sed 's/\..*$//')"
    if [ -n "$major" ] && [ "$major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; then
      if [ "$has_node" = "0" ]; then
        PATH="$NODE_INSTALL_DIR/bin:$PATH"
        export PATH
        info "Using Node.js v$existing from $NODE_INSTALL_DIR."
      fi
      return 0
    fi
  fi

  warn "Installing Node.js automatically…"
  install_node
}

# ── Main ─────────────────────────────────────────────────────────────────
ensure_node

# ── Install deckrun ──────────────────────────────────────────────────────
# Installed with the user's own permissions, never under sudo.
#
# The old condition here was `[ "$(id -u)" -eq 0 ] || [ -n "$(npm config get
# prefix)" ]`, and `npm config get prefix` essentially always prints a
# non-empty default, so the sudo branch was close to unreachable — and where
# it did fire, `sudo npm install -g` runs every package lifecycle script in
# the dependency tree as root.
info "Installing deckrun globally via npm…"
if ! npm install -g deckrun; then
  warn "npm could not install deckrun into its global prefix."
  warn "That prefix is probably not writable by you. Either point npm at a"
  warn "directory you own and re-run this installer:"
  warn ""
  warn "  npm config set prefix \"$HOME/.local\""
  warn ""
  warn "or install it yourself with whatever elevation you consider"
  warn "appropriate:  sudo npm install -g deckrun"
  exit 1
fi

# ── Verify ───────────────────────────────────────────────────────────────
if command -v deckrun >/dev/null 2>&1; then
  ok "deckrun ${BOLD}$(deckrun --version 2>/dev/null)${RESET} installed."
  say ""
  say "  ${BOLD}deckrun${RESET}              # open the editor"
  say "  ${BOLD}deckrun slides.md${RESET}    # present a local file"
  say "  ${BOLD}deckrun <url>${RESET}        # present a public Markdown or HTML URL"
  say ""
else
  warn "deckrun was installed but is not on your PATH."
  warn "Make sure your npm global bin directory is on PATH, then run 'deckrun'."
  if [ -n "$NODE_INSTALL_DIR" ] && [ -x "$NODE_INSTALL_DIR/bin/node" ]; then
    warn "If Node was just installed locally, open a new terminal or run:"
    say   "  export PATH=\"$NODE_INSTALL_DIR/bin:\$PATH\""
  fi
fi