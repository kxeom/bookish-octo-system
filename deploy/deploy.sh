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
pnpm install --frozen-lockfile
log "Dependencies terinstall"

# ─── Build ───────────────────────────────────────────────────────────────────
header "Build project"
cd "$APP_DIR/artifacts/api-server"
pnpm run build
log "Build selesai"

# ─── Start / Restart PM2 ─────────────────────────────────────────────────────
header "Start / Restart PM2"
cd "$APP_DIR"

# Load env vars dari .env
export $(grep -v '^#' "$ENV_FILE" | xargs)

if pm2 list | grep -q "$PM2_APP_NAME"; then
  pm2 restart "$PM2_APP_NAME"
  log "Bot di-restart via PM2"
else
  pm2 start artifacts/api-server/dist/index.mjs \
    --name "$PM2_APP_NAME" \
    --env production \
    --max-memory-restart 512M \
    --restart-delay 3000 \
    --max-restarts 10
  log "Bot distart via PM2"
fi

# Simpan PM2 config biar auto-start kalau VPS reboot
pm2 save
log "PM2 config disimpan"

# Setup PM2 startup (auto-start saat reboot)
if [ "$EUID" -eq 0 ]; then
  pm2 startup systemd -u root --hp /root > /dev/null 2>&1 || true
fi

# ─── Cek status ───────────────────────────────────────────────────────────────
header "Status Bot"
pm2 list

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
