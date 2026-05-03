import { Telegraf, Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { getUserState, setUserState, clearUserState } from './state';
import { isValidEmail } from './helpers';
import { startLoginFlow, submitOTP, closeSession, type StatusCallback } from './automation';
import { logger } from '../lib/logger';

const token = process.env['TELEGRAM_BOT_TOKEN'];
if (!token) throw new Error('TELEGRAM_BOT_TOKEN tidak ditemukan');

const bot = new Telegraf(token);

const PLAN_LABELS: Record<string, string> = {
  plus: '⭐ ChatGPT Plus',
  business: '💼 ChatGPT Business',
};

// Build a sendStatus function that sends a message to the user
function makeSendStatus(ctx: Context): StatusCallback {
  return async (msg: string) => {
    try {
      await ctx.reply(msg);
    } catch (err) {
      logger.warn({ err }, 'Failed to send status message');
    }
  };
}

// ─── /start ──────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  clearUserState(ctx.from.id);
  await ctx.reply(
    `👋 *Selamat datang di ChatGPT Upgrade Bot!*\n\n` +
      `Bot ini akan membantu kamu upgrade akun ChatGPT secara otomatis.\n\n` +
      `📋 *Cara Pemakaian:*\n` +
      `1. Pilih paket yang kamu inginkan\n` +
      `2. Masukkan email kamu\n` +
      `3. Masukkan OTP yang dikirim ke email\n` +
      `4. Bot memproses upgrade otomatis (kamu bisa lihat prosesnya real\\-time)\n` +
      `5. Konfirmasi setelah pembayaran selesai\n\n` +
      `⚠️ *Pastikan email kamu aktif dan dapat menerima OTP*\n\n` +
      `Pilih paket upgrade:`,
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⭐ Upgrade Plus', 'plan_plus')],
        [Markup.button.callback('💼 Upgrade Business', 'plan_business')],
      ]),
    },
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
    `✅ Kamu memilih ${PLAN_LABELS[plan]}\n\n` +
      `📧 Silahkan masukkan email kamu yang terdaftar atau akan didaftarkan di ChatGPT:`,
  );
}

// ─── Confirm sukses / batal ───────────────────────────────────────────────────
bot.action('confirm_success', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const state = getUserState(userId);

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply(
    `🎉 Upgrade Berhasil!\n\n` +
      `✅ Email ${state.email} sudah berhasil di-upgrade ke ${PLAN_LABELS[state.plan || 'plus']}!\n\n` +
      `Silahkan login ke ChatGPT dan nikmati fitur premium kamu! 🚀`,
  );

  await closeSession(userId);
  clearUserState(userId);
});

bot.action('confirm_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply(
    `❌ Upgrade Dibatalkan\n\n` +
      `Proses upgrade telah dibatalkan. Ketik /start untuk mencoba lagi.\n\n` +
      `Hubungi admin jika butuh bantuan lebih lanjut.`,
  );

  await closeSession(userId);
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
      await ctx.reply(
        `❌ Format email tidak valid. Pastikan email kamu benar.\n\nContoh: user@gmail.com`,
      );
      return;
    }

    setUserState(userId, { step: 'processing', email: text });

    await ctx.reply(
      `⏳ Memproses...\n\n` +
        `📧 Email: ${text}\n` +
        `📦 Paket: ${PLAN_LABELS[state.plan || 'plus']}\n\n` +
        `Kamu akan melihat update langkah-demi-langkah di bawah ini 👇`,
    );

    const sendStatus = makeSendStatus(ctx);

    try {
      await startLoginFlow(userId, text, sendStatus);
      setUserState(userId, { step: 'waiting_otp' });

      await ctx.reply(
        `📨 OTP Dikirim!\n\n` +
          `Kode OTP telah dikirim ke email ${text}\n\n` +
          `Silahkan cek inbox (atau folder spam) kamu, lalu kirimkan kode OTP di sini:`,
      );
    } catch (err) {
      logger.error({ err, userId }, 'Error in startLoginFlow');
      await closeSession(userId);
      clearUserState(userId);
      const shortErr = String((err as Error).message).slice(0, 300);
      await ctx.reply(
        `❌ Terjadi kesalahan saat menghubungi ChatGPT.\n\nError: ${shortErr}\n\nKetik /start untuk mencoba lagi.`,
      );
    }
    return;
  }

  // ── Waiting for OTP ────────────────────────────────────────────────────────
  if (state.step === 'waiting_otp') {
    const otp = text.replace(/\s/g, '');
    if (!/^\d{4,8}$/.test(otp)) {
      await ctx.reply(
        `❌ Format OTP tidak valid. OTP biasanya terdiri dari 4-8 digit angka.\n\nContoh: 123456`,
      );
      return;
    }

    setUserState(userId, { step: 'processing' });

    await ctx.reply(
      `✅ OTP diterima: ${otp}\n\n` +
        `Kamu akan melihat update prosesnya di bawah ini 👇`,
    );

    const sendStatus = makeSendStatus(ctx);

    try {
      const paymentLink = await submitOTP(userId, otp, state.plan || 'plus');
      setUserState(userId, { step: 'waiting_confirmation', paymentLink });

      await ctx.reply(
        `✅ Proses selesai!\n\n` +
          `💳 Silahkan selesaikan pembayaran pada link berikut:\n` +
          `${paymentLink}\n\n` +
          `Setelah kamu selesai melakukan pembayaran, klik tombol Sukses di bawah:`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Sukses', 'confirm_success'),
            Markup.button.callback('❌ Batal', 'confirm_cancel'),
          ],
        ]),
      );
    } catch (err) {
      logger.error({ err, userId }, 'Error in submitOTP');
      clearUserState(userId);
      await closeSession(userId);
      const shortErr = String((err as Error).message).slice(0, 300);
      await ctx.reply(
        `❌ Terjadi kesalahan saat memproses.\n\nError: ${shortErr}\n\nKetik /start untuk mencoba lagi.`,
      );
    }
    return;
  }

  // ── Processing ─────────────────────────────────────────────────────────────
  if (state.step === 'processing') {
    await ctx.reply(`⏳ Sedang memproses, harap tunggu...`);
    return;
  }

  // ── Default ────────────────────────────────────────────────────────────────
  await ctx.reply(`Ketik /start untuk memulai proses upgrade ChatGPT kamu.`);
});

export default bot;
