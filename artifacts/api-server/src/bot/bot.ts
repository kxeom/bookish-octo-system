import { Telegraf, Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { getUserState, setUserState, clearUserState } from './state';
import { isValidEmail } from './helpers';
import { startLoginFlow, submitOTP, closeSession, type StatusCallback } from './automation';
import { logger } from '../lib/logger';

const token = process.env['TELEGRAM_BOT_TOKEN'];
if (!token) throw new Error('TELEGRAM_BOT_TOKEN tidak ditemukan');

const bot = new Telegraf(token, { handlerTimeout: 600_000 }); // 10 menit

const PLAN_LABELS: Record<string, string> = {
  plus: '⭐ ChatGPT Plus',
  business: '💼 ChatGPT Business',
};

// ─── Whitelist ────────────────────────────────────────────────────────────────
const ALLOWED_USER_IDS = new Set([6786510674, 5911476963]);

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !ALLOWED_USER_IDS.has(userId)) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    await ctx.reply('Maaf, bot ini hanya untuk pengguna yang diizinkan.').catch(() => {});
    return;
  }
  return next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeSendStatus(userId: number): StatusCallback {
  return async (msg: string) => {
    try {
      await bot.telegram.sendMessage(userId, msg);
    } catch (err) {
      logger.warn({ err }, 'Failed to send status message');
    }
  };
}

function sendMsg(userId: number, text: string) {
  return bot.telegram.sendMessage(userId, text).catch((err) =>
    logger.warn({ err, userId }, 'Failed to send message'),
  );
}

// ─── /start ──────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await closeSession(userId).catch(() => {});
  clearUserState(userId);
  await ctx.reply(
    `Selamat datang di ChatGPT Upgrade Bot!\n\n` +
      `Bot ini akan membantu kamu upgrade akun ChatGPT secara otomatis.\n\n` +
      `Cara Pemakaian:\n` +
      `1. Pilih paket yang kamu inginkan\n` +
      `2. Masukkan email kamu\n` +
      `3. Masukkan OTP yang dikirim ke email\n` +
      `4. Bot memproses upgrade otomatis\n` +
      `5. Selesaikan pembayaran di link yang dikirim bot\n` +
      `6. Klik Sukses setelah bayar\n\n` +
      `Pastikan email kamu aktif dan dapat menerima OTP\n\n` +
      `Pilih paket upgrade:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Upgrade Plus', 'plan_plus')],
      [Markup.button.callback('Upgrade Business', 'plan_business')],
    ]),
  );
});

// ─── Plan selection ───────────────────────────────────────────────────────────
bot.action('plan_plus', async (ctx) => {
  await ctx.answerCbQuery();
  await handlePlanSelect(ctx, 'plus');
});

bot.action('plan_business', async (ctx) => {
  await ctx.answerCbQuery();
  await handlePlanSelect(ctx, 'business');
});

async function handlePlanSelect(ctx: Context, plan: 'plus' | 'business') {
  const userId = ctx.from!.id;
  setUserState(userId, { step: 'waiting_email', plan });
  await ctx.reply(
    `Kamu memilih ${PLAN_LABELS[plan]}\n\n` +
      `Silahkan masukkan email kamu yang terdaftar atau akan didaftarkan di ChatGPT:`,
  );
}

// ─── Confirm sukses / batal ───────────────────────────────────────────────────
bot.action('confirm_success', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (_) { /* ignore */ }

  const userId = ctx.from!.id;
  const state = getUserState(userId);

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (_) { /* message might be old — ignore */ }

  await ctx.reply(
    `Upgrade Berhasil!\n\n` +
      `Email ${state.email ?? '-'} sudah berhasil di-upgrade ke ${PLAN_LABELS[state.plan ?? 'plus']}!\n\n` +
      `Silahkan login ke ChatGPT dan nikmati fitur premium kamu!`,
  );

  await closeSession(userId).catch(() => {});
  clearUserState(userId);
});

bot.action('confirm_cancel', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (_) { /* ignore */ }

  const userId = ctx.from!.id;

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (_) { /* ignore */ }

  await ctx.reply(
    `Upgrade Dibatalkan\n\n` +
      `Proses upgrade telah dibatalkan. Ketik /start untuk mencoba lagi.\n\n` +
      `Hubungi admin jika butuh bantuan lebih lanjut.`,
  );

  await closeSession(userId).catch(() => {});
  clearUserState(userId);
});

// ─── Text handler ─────────────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const state = getUserState(userId);

  if (text.startsWith('/')) return;

  // ── Waiting for email ──────────────────────────────────────────────────────
  if (state.step === 'waiting_email') {
    if (!isValidEmail(text)) {
      await ctx.reply(`Format email tidak valid. Pastikan email kamu benar.\n\nContoh: user@gmail.com`);
      return;
    }

    setUserState(userId, { step: 'processing', email: text });

    await ctx.reply(
      `Memproses...\n\n` +
        `Email: ${text}\n` +
        `Paket: ${PLAN_LABELS[state.plan || 'plus']}\n\n` +
        `Kamu akan melihat update langkah-demi-langkah di bawah ini`,
    );

    const sendStatus = makeSendStatus(userId);

    try {
      await startLoginFlow(userId, text, sendStatus);
      setUserState(userId, { step: 'waiting_otp' });
      await sendMsg(
        userId,
        `OTP Dikirim!\n\n` +
          `Kode OTP telah dikirim ke email ${text}\n\n` +
          `Silahkan cek inbox (atau folder spam) kamu, lalu kirimkan kode OTP di sini:`,
      );
    } catch (err) {
      logger.error({ err, userId }, 'Error in startLoginFlow');
      await closeSession(userId).catch(() => {});
      clearUserState(userId);
      const shortErr = String((err as Error).message).slice(0, 300);
      await sendMsg(userId, `Terjadi kesalahan saat menghubungi ChatGPT.\n\nError: ${shortErr}\n\nKetik /start untuk mencoba lagi.`);
    }
    return;
  }

  // ── Waiting for OTP ────────────────────────────────────────────────────────
  if (state.step === 'waiting_otp') {
    const otp = text.replace(/\s/g, '');
    if (!/^\d{4,8}$/.test(otp)) {
      await ctx.reply(`Format OTP tidak valid. OTP biasanya terdiri dari 4-8 digit angka.\n\nContoh: 123456`);
      return;
    }

    const plan = state.plan || 'plus';
    setUserState(userId, { step: 'processing' });

    await ctx.reply(`OTP diterima: ${otp}\n\nKamu akan melihat update prosesnya di bawah ini`);

    const sendStatus = makeSendStatus(userId);

    // Run async — do NOT await here so Telegraf handler returns immediately
    // and avoids the 90s timeout. Results sent via bot.telegram.sendMessage.
    (async () => {
      try {
        const paymentLink = await submitOTP(userId, otp, plan);
        setUserState(userId, { step: 'waiting_confirmation', paymentLink });

        await bot.telegram.sendMessage(
          userId,
          `Proses selesai!\n\nSilahkan selesaikan pembayaran pada link berikut:\n${paymentLink}\n\nSetelah kamu selesai melakukan pembayaran, klik tombol Sukses di bawah:`,
          Markup.inlineKeyboard([
            [
              Markup.button.callback('Sukses', 'confirm_success'),
              Markup.button.callback('Batal', 'confirm_cancel'),
            ],
          ]),
        );
      } catch (err) {
        logger.error({ err, userId }, 'Error in submitOTP');
        await closeSession(userId).catch(() => {});
        clearUserState(userId);
        const shortErr = String((err as Error).message).slice(0, 300);
        await sendMsg(userId, `Terjadi kesalahan saat memproses.\n\nError: ${shortErr}\n\nKetik /start untuk mencoba lagi.`);
      }
    })();

    return;
  }

  // ── Processing ─────────────────────────────────────────────────────────────
  if (state.step === 'processing') {
    await ctx.reply(`Sedang memproses, harap tunggu...`);
    return;
  }

  // ── Default ────────────────────────────────────────────────────────────────
  await ctx.reply(`Ketik /start untuk memulai proses upgrade ChatGPT kamu.`);
});

export default bot;
