#!/bin/bash
# =============================================================================
# YushaGPT Bot — Setup Script untuk VPS (Ubuntu / Debian)
# Jalankan sekali saat pertama kali setup VPS
# Usage: bash setup.sh
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

# ─── Cek root ────────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  error "Jalankan script ini sebagai root: sudo bash setup.sh"
fi

header "YushaGPT Bot — VPS Setup"

# ─── 1. Update sistem ─────────────────────────────────────────────────────────
header "1/7 Update sistem"
apt-get update -qq && apt-get upgrade -y -qq
log "Sistem updated"

# ─── 2. Install dependencies dasar ───────────────────────────────────────────
header "2/7 Install dependencies"
apt-get install -y -qq \
  curl wget git unzip ca-certificates gnupg \
  build-essential libssl-dev \
  fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
  libgtk-3-0 libnspr4 libnss3 libx11-6 libxcomposite1 libxdamage1 \
  libxext6 libxfixes3 libxrandr2 libxss1 libxtst6 xdg-utils \
  libu2f-udev libvulkan1
log "Dependencies dasar terinstall"

# ─── 3. Install Chromium ──────────────────────────────────────────────────────
header "3/7 Install Chromium"
apt-get install -y -qq chromium-browser 2>/dev/null || apt-get install -y -qq chromium 2>/dev/null || {
  warn "Mencoba install via snap..."
  snap install chromium
}
CHROMIUM_PATH=$(which chromium-browser 2>/dev/null || which chromium 2>/dev/null || echo "")
if [ -z "$CHROMIUM_PATH" ]; then
  error "Chromium tidak berhasil diinstall. Install manual: apt-get install chromium-browser"
fi
log "Chromium terinstall di: $CHROMIUM_PATH"

# ─── 4. Install Node.js 24 ────────────────────────────────────────────────────
header "4/7 Install Node.js 24"
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 24 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - -qq
  apt-get install -y -qq nodejs
  log "Node.js $(node -v) terinstall"
else
  log "Node.js sudah ada: $(node -v)"
fi

# ─── 5. Install pnpm ──────────────────────────────────────────────────────────
header "5/7 Install pnpm"
npm install -g pnpm@latest --silent
log "pnpm $(pnpm -v) terinstall"

# ─── 6. Install PM2 ──────────────────────────────────────────────────────────
header "6/7 Install PM2"
npm install -g pm2@latest --silent
log "PM2 $(pm2 -v) terinstall"

# ─── 7. Buat folder app ───────────────────────────────────────────────────────
header "7/7 Persiapan direktori"
mkdir -p /opt/yushaagpt
log "Direktori /opt/yushaagpt siap"

# ─── Selesai ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Setup selesai! Langkah berikutnya: ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo "  1. Clone repo ke /opt/yushaagpt:"
echo "     git clone https://github.com/username/repo.git /opt/yushaagpt"
echo ""
echo "  2. Masuk ke folder:"
echo "     cd /opt/yushaagpt"
echo ""
echo "  3. Jalankan deploy script:"
echo "     bash deploy/deploy.sh"
echo ""
echo -e "  Chromium path: ${YELLOW}$CHROMIUM_PATH${NC}"
echo ""
