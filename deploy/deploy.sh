#!/bin/bash
# =============================================================================
# YushaGPT Bot — Deploy / Update Script
# Jalankan ini setiap kali mau update bot dari GitHub
# Usage: bash deploy/deploy.sh
# =============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()   { echo -e "${YELLOW}[!]${NC} $1"; }
error()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
header() { echo -e "\n${BLUE}══════════════════════════════════════${NC}"; echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}══════════════════════════════════════${NC}\n"; }

# ─── Fix PATH agar pnpm & pm2 selalu ketemu ───────────────────────────────────
export PATH="$PATH:/usr/local/bin:/usr/bin:/root/.local/share/pnpm:/home/$SUDO_USER/.local/share/pnpm"

# ─── Cari pnpm & pm2 ─────────────────────────────────────────────────────────
PNPM_BIN=$(command -v pnpm 2>/dev/null || echo "")
PM2_BIN=$(command -v pm2 2>/dev/null || echo "")

if [ -z "$PNPM_BIN" ]; then
  warn "pnpm tidak ditemukan di PATH, mencoba install ulang..."
  npm install -g pnpm@latest
  # Re-assign setelah install
  hash -r 2>/dev/null || true
  PNPM_BIN=$(command -v pnpm 2>/dev/null || ls /usr/local/bin/pnpm 2>/dev/null || ls /usr/bin/pnpm 2>/dev/null || echo "")
  [ -z "$PNPM_BIN" ] && error "pnpm tetap tidak ditemukan. Jalankan: ln -sf \$(npm root -g)/../bin/pnpm /usr/bin/pnpm"
fi

if [ -z "$PM2_BIN" ]; then
  warn "pm2 tidak ditemukan di PATH, mencoba install ulang..."
  npm install -g pm2@latest
  # Re-assign setelah install
  hash -r 2>/dev/null || true
  PM2_BIN=$(command -v pm2 2>/dev/null || ls /usr/local/bin/pm2 2>/dev/null || ls /usr/bin/pm2 2>/dev/null || echo "")
  [ -z "$PM2_BIN" ] && error "pm2 tetap tidak ditemukan. Jalankan: ln -sf \$(npm root -g)/../bin/pm2 /usr/bin/pm2"
fi

log "pnpm ditemukan: $PNPM_BIN"
log "pm2  ditemukan: $PM2_BIN"

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
PM2_APP_NAME="yushaagpt-bot"

header "YushaGPT Bot — Deploy"
log "App dir: $APP_DIR"

# ─── Cek .env ada ────────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  warn ".env tidak ditemukan! Membuat dari template..."
  cat > "$ENV_FILE" <<'EOF'
# Telegram Bot Token dari @BotFather
TELEGRAM_BOT_TOKEN=ISI_TOKEN_KAMU_DI_SINI

# Secret key untuk session (isi string random panjang)
SESSION_SECRET=ISI_SECRET_RANDOM_DI_SINI

# Environment
NODE_ENV=production

# Port server
PORT=8080
EOF
  echo ""
  echo -e "${RED}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║  .env baru dibuat — WAJIB isi dulu sebelum  ║${NC}"
  echo -e "${RED}║  lanjut deploy!                              ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════╝${NC}"
  echo ""
  echo "  Edit file .env:"
  echo "  nano $ENV_FILE"
  echo ""
  exit 1
fi

# Validasi token sudah diisi
if grep -q "ISI_TOKEN_KAMU_DI_SINI" "$ENV_FILE"; then
  error ".env belum diisi! Buka dan isi TELEGRAM_BOT_TOKEN dulu:\n  nano $ENV_FILE"
fi

log ".env ditemukan dan valid"

# ─── Pull latest code ─────────────────────────────────────────────────────────
header "Pull latest code dari GitHub"
cd "$APP_DIR"
git pull origin main
log "Code updated"

# ─── Install dependencies ─────────────────────────────────────────────────────
header "Install dependencies"
"$PNPM_BIN" install --frozen-lockfile
log "Dependencies terinstall"

# ─── Build ───────────────────────────────────────────────────────────────────
header "Build project"
cd "$APP_DIR/artifacts/api-server"
"$PNPM_BIN" run build
log "Build selesai"

# ─── Start / Restart PM2 ─────────────────────────────────────────────────────
header "Start / Restart PM2"
cd "$APP_DIR"

# Load env vars dari .env
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if "$PM2_BIN" list | grep -q "$PM2_APP_NAME"; then
  "$PM2_BIN" restart "$PM2_APP_NAME"
  log "Bot di-restart via PM2"
else
  "$PM2_BIN" start artifacts/api-server/dist/index.mjs \
    --name "$PM2_APP_NAME" \
    --max-memory-restart 512M \
    --restart-delay 3000 \
    --max-restarts 10
  log "Bot distart via PM2"
fi

# Simpan PM2 config biar auto-start kalau VPS reboot
"$PM2_BIN" save
log "PM2 config disimpan"

# Setup PM2 startup (auto-start saat reboot)
if [ "$EUID" -eq 0 ]; then
  "$PM2_BIN" startup systemd -u root --hp /root > /dev/null 2>&1 || true
fi

# ─── Cek status ───────────────────────────────────────────────────────────────
header "Status Bot"
"$PM2_BIN" list

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Deploy berhasil!             ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo "  Lihat logs bot:"
echo "  pm2 logs $PM2_APP_NAME"
echo ""
echo "  Stop bot:"
echo "  pm2 stop $PM2_APP_NAME"
echo ""
echo "  Restart bot:"
echo "  pm2 restart $PM2_APP_NAME"
echo ""
