#!/bin/bash
# =============================================================================
# YushaGPT Bot — Deploy / Update Script
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

# ─── Auto-fix symlinks pnpm & pm2 ke /usr/bin (selalu ada di PATH) ────────────
_fix_symlink() {
  local tool="$1"
  if ! command -v "$tool" &>/dev/null; then
    warn "$tool tidak ada di PATH, buat symlink ke /usr/bin/$tool..."
    local src
    src="$(npm root -g 2>/dev/null | sed 's|node_modules$||')bin/$tool"
    if [ -f "$src" ]; then
      ln -sf "$src" "/usr/bin/$tool"
      log "Symlink dibuat: /usr/bin/$tool → $src"
    else
      error "$tool tidak ditemukan di $src. Jalankan: npm install -g $tool"
    fi
  fi
}

_fix_symlink pnpm
_fix_symlink pm2

log "pnpm : $(pnpm -v)"
log "pm2  : $(pm2 -v)"

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
PM2_APP_NAME="yushaagpt-bot"

header "YushaGPT Bot — Deploy"
log "App dir: $APP_DIR"

# ─── Cek .env ────────────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  warn ".env tidak ditemukan! Membuat dari template..."
  cat > "$ENV_FILE" <<'EOF'
# Telegram Bot Token dari @BotFather
TELEGRAM_BOT_TOKEN=ISI_TOKEN_KAMU_DI_SINI

# Secret key untuk session (isi string random panjang)
SESSION_SECRET=ISI_SECRET_RANDOM_DI_SINI

NODE_ENV=production
PORT=8080
EOF
  echo ""
  echo -e "${RED}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║  .env baru dibuat — WAJIB isi dulu sebelum  ║${NC}"
  echo -e "${RED}║  lanjut deploy!                              ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════╝${NC}"
  echo ""
  echo "  Edit: nano $ENV_FILE"
  echo ""
  exit 1
fi

if grep -q "ISI_TOKEN_KAMU_DI_SINI" "$ENV_FILE"; then
  error ".env belum diisi! Buka dan isi dulu:\n  nano $ENV_FILE"
fi

log ".env valid"

# ─── Pull latest code ─────────────────────────────────────────────────────────
header "Pull latest code"
cd "$APP_DIR"
git pull origin main
log "Code updated"

# ─── Install dependencies ─────────────────────────────────────────────────────
header "Install dependencies"
pnpm install --frozen-lockfile
log "Dependencies terinstall"

# ─── Build ───────────────────────────────────────────────────────────────────
header "Build project"
cd "$APP_DIR/artifacts/api-server"
pnpm run build
log "Build selesai"

# ─── Load env & Start/Restart PM2 ────────────────────────────────────────────
header "Start / Restart PM2"
cd "$APP_DIR"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if pm2 list | grep -q "$PM2_APP_NAME"; then
  pm2 restart "$PM2_APP_NAME"
  log "Bot di-restart"
else
  pm2 start artifacts/api-server/dist/index.mjs \
    --name "$PM2_APP_NAME" \
    --max-memory-restart 512M \
    --restart-delay 3000 \
    --max-restarts 10
  log "Bot distart"
fi

pm2 save
log "PM2 config disimpan"

if [ "$EUID" -eq 0 ]; then
  pm2 startup systemd -u root --hp /root > /dev/null 2>&1 || true
fi

header "Status Bot"
pm2 list

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Deploy berhasil!             ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo "  pm2 logs $PM2_APP_NAME   → lihat logs"
echo "  pm2 restart $PM2_APP_NAME → restart"
echo "  pm2 stop $PM2_APP_NAME    → stop"
echo ""
