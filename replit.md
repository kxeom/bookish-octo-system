# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Telegram bot**: Telegraf v4
- **Browser automation**: Playwright (Chromium headless)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Telegram Bot (`@yushaagptbot`)

Auto payment bot for upgrading ChatGPT accounts.

### Flow:
1. `/start` → Welcome message + Upgrade Plus / Upgrade Business buttons
2. User selects plan → Bot asks for email
3. User sends email → Playwright opens Chromium, logs in to chatgpt.com
4. ChatGPT sends OTP to email → Bot asks user for OTP
5. User sends OTP → Bot continues automation
6. Handles existing account (redirect to home) or new account (fills random name + birthday)
7. Fetches session from `https://chatgpt.com/api/auth/session`
8. Calls `https://ezweystock.petrix.id/gpt/payment` to get checkout URL
9. Opens checkout URL, selects GoPay, fills random address, clicks Subscribe
10. Sends final redirect URL to user with Sukses/Batal buttons
11. User confirms → Task done

### Key Files:
- `artifacts/api-server/src/bot/bot.ts` — Telegraf bot handlers
- `artifacts/api-server/src/bot/automation.ts` — Playwright automation logic
- `artifacts/api-server/src/bot/state.ts` — Per-user state store
- `artifacts/api-server/src/bot/helpers.ts` — Random name/date generators

### Env Secrets:
- `TELEGRAM_BOT_TOKEN` — Bot token from BotFather

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
