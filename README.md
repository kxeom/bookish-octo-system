<div align="center">

# 🤖 YushaGPT Bot

**Telegram bot untuk upgrade akun ChatGPT (Plus/Business) secara otomatis via GoPay**

[![Node.js](https://img.shields.io/badge/Node.js-24-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Telegraf](https://img.shields.io/badge/Telegraf-v4-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://telegraf.js.org)
[![Playwright](https://img.shields.io/badge/Playwright-Chromium-45ba4b?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?style=for-the-badge&logo=pnpm&logoColor=white)](https://pnpm.io)

</div>

---

## 📋 Daftar Isi

- [Fitur](#-fitur)
- [Cara Kerja](#-cara-kerja)
- [Struktur Project](#-struktur-project)
- [Prasyarat](#-prasyarat)
- [Instalasi](#-instalasi)
- [Konfigurasi](#-konfigurasi)
  - [Environment Variables](#environment-variables)
  - [Whitelist User](#whitelist-user)
- [Menjalankan Bot](#-menjalankan-bot)
- [Deployment ke VPS](#-deployment-ke-vps)
- [Stack Teknologi](#-stack-teknologi)
- [FAQ](#-faq)

---

## ✨ Fitur

| Fitur | Keterangan |
|---|---|
| 🔐 Login otomatis | Playwright membuka ChatGPT, input email & OTP secara human-like |
| 🧠 Anti-deteksi | Stealth mode: disable automation flags, random mouse movement, human typing |
| 🆕 New account flow | Auto-isi nama, umur di halaman `/about-you` |
| 💳 Checkout GoPay | Pilih GoPay, isi billing address random Indonesia, klik Subscribe |
| 🏷️ Deteksi harga | Cek "Due today" — proses dihentikan otomatis kalau harga bukan IDR 0 |
| 🔗 Midtrans link | Capture redirect ke Midtrans & kirim ke user |
| 🔄 Auto-restart | Server restart otomatis setelah tiap sesi selesai |
| 🛡️ Whitelist | Hanya user ID yang diizinkan yang bisa menggunakan bot |
| 🌍 Random address | Generate nama, alamat, kota, provinsi, kode pos Indonesia yang acak tiap sesi |
| 🧹 Session wipe | Hapus semua cookies/localStorage setelah tiap sesi |

---

## 🔄 Cara Kerja

```
User ketik /start
        │
        ▼
Pilih Paket (Plus / Business)
        │
        ▼
Masukkan Email ChatGPT
        │
        ▼
Bot buka Chromium (headless + stealth)
→ Buka chatgpt.com
→ Klik "Log in"
→ Ketik email (human-like)
→ Klik Continue
        │
        ▼
ChatGPT kirim OTP ke email
        │
        ▼
User kirim OTP ke bot
        │
        ▼
Bot submit OTP di browser
→ Jika akun baru: isi nama & umur di /about-you
→ Tunggu redirect ke chatgpt.com home
        │
        ▼
Ambil session token dari /api/auth/session
        │
        ▼
Call Payment API → dapat Stripe checkout URL
        │
        ▼
Buka checkout URL
→ Cek harga "Due today"
  ├── IDR 0? ✅ Lanjut
  └── Bukan 0? ❌ Hentikan, info ke user
        │
        ▼
Pilih GoPay di Stripe iframe
→ Isi billing: nama, negara, alamat, kota, provinsi, kode pos (random)
→ Klik Subscribe
        │
        ▼
Tunggu redirect ke Midtrans (max 60 detik)
        │
        ▼
Kirim link Midtrans ke user + tombol [Sukses] [Batal]
        │
        ▼
User selesaikan pembayaran → klik Sukses
        │
        ▼
Browser ditutup + data dihapus
Server auto-restart (fresh IP untuk sesi berikutnya)
```

---

## 📁 Struktur Project

```
.
├── artifacts/
│   └── api-server/               # Main server + Telegram bot
│       ├── src/
│       │   ├── bot/
│       │   │   ├── automation.ts # Playwright automation (login, OTP, checkout)
│       │   │   ├── bot.ts        # Telegraf handlers & whitelist
│       │   │   ├── helpers.ts    # Random name/address generator
│       │   │   ├── state.ts      # Per-user state store (in-memory)
│       │   │   └── types.ts      # TypeScript types
│       │   ├── lib/
│       │   │   └── logger.ts     # Pino logger
│       │   └── index.ts          # Express server entrypoint
│       ├── build.mjs             # esbuild config
│       └── package.json
├── lib/                          # Shared workspace libraries
├── scripts/                      # Utility scripts
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

---

## 🛠️ Prasyarat

Pastikan sudah terinstall:

- **Node.js** `>= 24` — [Download](https://nodejs.org)
- **pnpm** `>= 9` — Install via `npm install -g pnpm`
- **Chromium** (system) — untuk Playwright headless
- **Telegram Bot Token** — buat bot via [@BotFather](https://t.me/BotFather)

### Install Chromium (Linux/Ubuntu)

```bash
sudo apt-get update
sudo apt-get install -y chromium-browser
```

> Cek path Chromium: `which chromium` atau `which chromium-browser`
> Sesuaikan path di `automation.ts` → variabel `SYSTEM_CHROMIUM` jika berbeda.

---

## 🚀 Instalasi

### 1. Clone repository

```bash
git clone https://github.com/username/yushaagpt-bot.git
cd yushaagpt-bot
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Setup environment variables

Buat file `.env` di root project (atau set di server):

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
SESSION_SECRET=your_random_secret_here
```

### 4. Build project

```bash
cd artifacts/api-server
pnpm run build
```

---

## ⚙️ Konfigurasi

### Environment Variables

| Variable | Wajib | Keterangan |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token bot dari [@BotFather](https://t.me/BotFather) |
| `SESSION_SECRET` | ✅ | Secret key untuk session (string random panjang) |
| `PORT` | ❌ | Port server (default: `8080`) |
| `NODE_ENV` | ❌ | `development` atau `production` |

#### Cara dapat `TELEGRAM_BOT_TOKEN`:
1. Buka Telegram → cari [@BotFather](https://t.me/BotFather)
2. Ketik `/newbot`
3. Ikuti instruksi → dapatkan token format: `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`

---

### Whitelist User

Hanya Telegram user ID yang ada di whitelist yang bisa menggunakan bot.

**File:** `artifacts/api-server/src/bot/bot.ts`

```typescript
// Baris ~19
const ALLOWED_USER_IDS = new Set([
  6786510674,   // User 1
  5911476963,   // User 2
  // Tambahkan ID baru di sini
]);
```

#### Cara mencari Telegram User ID:

1. Buka Telegram → cari [@userinfobot](https://t.me/userinfobot)
2. Ketik `/start`
3. Bot akan reply dengan ID kamu

#### Cara menambah/menghapus user:

```typescript
// Tambah user baru:
const ALLOWED_USER_IDS = new Set([
  6786510674,
  5911476963,
  987654321,   // ← tambahkan di sini
]);

// Hapus user:
// Cukup hapus baris ID-nya
```

Setelah edit, **rebuild dan restart server**:

```bash
cd artifacts/api-server
pnpm run build
# Restart server
```

---

## ▶️ Menjalankan Bot

### Mode Development

```bash
pnpm --filter @workspace/api-server run dev
```

Perintah ini otomatis: `build` → `start`

### Mode Production

```bash
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
```

### Cek apakah server jalan

```bash
curl http://localhost:8080/api/healthz
```

---

## 🖥️ Deployment ke VPS

> Semua perintah di bawah dijalankan di dalam VPS kamu via SSH.

---

### Langkah 1 — Setup awal VPS (sekali saja)

SSH masuk ke VPS, lalu jalankan setup script otomatis:

```bash
# Download dan jalankan setup script
curl -fsSL https://raw.githubusercontent.com/USERNAME/REPO/main/deploy/setup.sh -o setup.sh
sudo bash setup.sh
```

Script ini otomatis menginstall:
- ✅ Node.js 24
- ✅ pnpm
- ✅ PM2 (process manager — biar bot jalan terus)
- ✅ Chromium + semua dependencies-nya
- ✅ Git, curl, dan tools lainnya

---

### Langkah 2 — Clone & Deploy

```bash
# Clone repo ke /opt/yushaagpt
git clone https://github.com/USERNAME/REPO.git /opt/yushaagpt
cd /opt/yushaagpt

# Jalankan deploy script
bash deploy/deploy.sh
```

Script akan otomatis membuat file `.env` dan meminta kamu mengisinya jika belum ada.

#### Isi file .env

```bash
nano /opt/yushaagpt/.env
```

```env
TELEGRAM_BOT_TOKEN=isi_token_dari_botfather
SESSION_SECRET=isi_string_random_panjang
NODE_ENV=production
PORT=8080
```

> Generate `SESSION_SECRET` yang aman: `openssl rand -base64 32`

Setelah `.env` diisi, jalankan deploy lagi:

```bash
bash deploy/deploy.sh
```

---

### Langkah 3 — Update bot (seterusnya)

Setiap kali ada perubahan kode di GitHub, cukup jalankan:

```bash
cd /opt/yushaagpt
bash deploy/deploy.sh
```

Script akan otomatis: `git pull` → `pnpm install` → `build` → `restart PM2`

---

### Perintah PM2 berguna

```bash
# Lihat status bot
pm2 list

# Lihat logs real-time
pm2 logs yushaagpt-bot

# Restart bot
pm2 restart yushaagpt-bot

# Stop bot
pm2 stop yushaagpt-bot

# Start bot (setelah stop)
pm2 start yushaagpt-bot

# Monitor CPU & RAM
pm2 monit
```

---

### Auto-start setelah VPS reboot

PM2 sudah dikonfigurasi auto-start oleh deploy script. Tapi kalau perlu setup manual:

```bash
pm2 startup
pm2 save
```

---

## 🧰 Stack Teknologi

| Teknologi | Versi | Kegunaan |
|---|---|---|
| [Node.js](https://nodejs.org) | 24 | Runtime |
| [TypeScript](https://www.typescriptlang.org) | 5.9 | Type safety |
| [pnpm](https://pnpm.io) | 9+ | Package manager + monorepo |
| [Express](https://expressjs.com) | 5 | HTTP server |
| [Telegraf](https://telegraf.js.org) | 4 | Telegram bot framework |
| [Playwright](https://playwright.dev) | 1.59+ | Browser automation |
| [Chromium](https://www.chromium.org) | System | Headless browser |
| [Pino](https://getpino.io) | 9 | Structured logging |
| [esbuild](https://esbuild.github.io) | 0.27 | Bundler (fast build) |

---

## ❓ FAQ

<details>
<summary><b>Bot tidak merespons pesan saya</b></summary>

Pastikan Telegram User ID kamu sudah ditambahkan ke whitelist di `bot.ts`. Lihat bagian [Whitelist User](#whitelist-user).

</details>

<details>
<summary><b>Harga checkout bukan IDR 0</b></summary>

Free trial hanya tersedia untuk akun baru yang belum pernah subscribe. Pastikan:
- Email yang digunakan belum pernah dipakai subscribe ChatGPT Plus
- Coba dengan email baru

</details>

<details>
<summary><b>Error: "Chromium not found"</b></summary>

Sesuaikan path Chromium di file `automation.ts`:

```typescript
// Cari variabel ini dan sesuaikan pathnya
const SYSTEM_CHROMIUM = '/usr/bin/chromium-browser';
// atau
const SYSTEM_CHROMIUM = '/usr/bin/chromium';
```

Cek path Chromium di sistem kamu: `which chromium`

</details>

<details>
<summary><b>OTP tidak terdeteksi</b></summary>

- Pastikan email yang dimasukkan benar
- Cek folder spam di email
- OTP berlaku hanya beberapa menit — pastikan input cepat setelah terima email

</details>

<details>
<summary><b>Tidak ada redirect ke Midtrans setelah klik Subscribe</b></summary>

Bisa jadi karena:
- Field billing tidak terisi dengan benar (cek logs)
- Stripe mendeteksi bot (coba restart server)
- Koneksi lambat — timeout 60 detik mungkin tidak cukup

</details>

<details>
<summary><b>Cara melihat logs</b></summary>

```bash
# Development (langsung di terminal)
pnpm --filter @workspace/api-server run dev

# Production dengan PM2
pm2 logs yushaagpt-bot
```

</details>

<details>
<summary><b>Cara menambah paket selain Plus dan Business</b></summary>

Edit `bot.ts`:

```typescript
// Tambah di PLAN_LABELS
const PLAN_LABELS: Record<string, string> = {
  plus: '⭐ ChatGPT Plus',
  business: '💼 ChatGPT Business',
  team: '👥 ChatGPT Team',  // ← tambah di sini
};

// Tambah tombol di /start handler
Markup.inlineKeyboard([
  [Markup.button.callback('Upgrade Plus', 'plan_plus')],
  [Markup.button.callback('Upgrade Business', 'plan_business')],
  [Markup.button.callback('Upgrade Team', 'plan_team')],  // ← tambah
])
```

</details>

---

<div align="center">

**Made with ❤️ — YushaGPT Bot**

</div>
