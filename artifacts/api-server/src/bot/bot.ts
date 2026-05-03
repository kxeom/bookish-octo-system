import { Telegraf, Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { getUserState, setUserState, clearUserState } from './state';
import { isValidEmail } from './helpers';
import { startLoginFlow, submitOTP, closeSession } from './automation';
import { logger } from '../lib/logger';

const token = process.env['TELEGRAM_BOT_TOKEN'];
if (!token) throw new Error('TELEGRAM_BOT_TOKEN tidak ditemukan');

const bot = new Telegraf(token);

const PLAN_LABELS: Record<string, string> = {
  plus: '⭐ ChatGPT Plus',
  business: '💼 ChatGPT Business',
};

// /start command
bot.start(async (ctx) => {
  clearUserState(ctx.from.id);
  await ctx.reply(
    `👋 *Selamat datang di ChatGPT Upgrade Bot!*\n\n` +
      `Bot ini akan membantu kamu upgrade akun ChatGPT kamu secara otomatis.\n\n` +
      `📋 *Cara Pemakaian:*\n` +
      `1. Pilih paket yang kamu inginkan\n` +
      `2. Masukkan email kamu\n` +
      `3. Masukkan OTP yang dikirim ke email\n` +
      `4. Bot akan memproses upgrade secara otomatis\n` +
      `5. Konfirmasi setelah pembayaran selesai\n\n` +
      `⚠️ *Pastikan email kamu aktif dan dapat menerima OTP*\n\n` +
      `Pilih paket upgrade:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⭐ Upgrade Plus', 'plan_plus')],
        [Markup.button.callback('💼 Upgrade Business', 'plan_business')],
      ]),
    },
  );
});

// Plan selection
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
    `✅ Kamu memilih *${PLAN_LABELS[plan]}*\n\n` +
      `📧 Silahkan masukkan *email* kamu yang terdaftar atau akan didaftarkan di ChatGPT:`,
    { parse_mode: 'Markdown' },
  );
}

// Handle sukses/batal confirmation
bot.action('confirm_success', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const state = getUserState(userId);

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply(
    `🎉 *Upgrade Berhasil!*\n\n` +
      `✅ Email *${state.email}* sudah berhasil di-upgrade ke *${PLAN_LABELS[state.plan || 'plus']}*!\n\n` +
      `Terima kasih sudah menggunakan layanan kami. Silahkan login ke ChatGPT dan nikmati fitur premium kamu! 🚀`,
    { parse_mode: 'Markdown' },
  );

  await closeSession(userId);
  clearUserState(userId);
});

bot.action('confirm_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply(
    `❌ *Upgrade Dibatalkan*\n\n` +
      `Proses upgrade telah dibatalkan. Jika ada masalah atau ingin mencoba lagi, ketik /start.\n\n` +
      `Hubungi admin jika butuh bantuan lebih lanjut.`,
    { parse_mode: 'Markdown' },
  );

  await closeSession(userId);
  clearUserState(userId);
});

// Handle all text messages
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const state = getUserState(userId);

  // Ignore commands
  if (text.startsWith('/')) return;

  if (state.step === 'waiting_email') {
    if (!isValidEmail(text)) {
      await ctx.reply(
        `❌ Format email tidak valid. Pastikan email kamu benar.\n\nContoh: *user@gmail.com*`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    setUserState(userId, { step: 'processing', email: text });

    const processingMsg = await ctx.reply(
      `⏳ *Memproses...*\n\n` +
        `📧 Email: \`${text}\`\n` +
        `📦 Paket: ${PLAN_LABELS[state.plan || 'plus']}\n\n` +
        `🌐 Membuka browser dan menghubungi ChatGPT...\n` +
        `Mohon tunggu sebentar.`,
      { parse_mode: 'Markdown' },
    );

    try {
      await startLoginFlow(userId, text);

      setUserState(userId, { step: 'waiting_otp', messageId: processingMsg.message_id });

      await ctx.reply(
        `📨 *OTP Dikirim!*\n\n` +
          `Kode OTP telah dikirim ke email *${text}*.\n\n` +
          `Silahkan cek inbox (atau spam) kamu dan kirimkan kode OTP di sini:`,
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      logger.error({ err, userId }, 'Error in startLoginFlow');
      setUserState(userId, { step: 'waiting_email' });
      const shortErr = String((err as Error).message).slice(0, 200);
      await ctx.reply(
        `❌ Terjadi kesalahan saat menghubungi ChatGPT.\n\n` +
          `Error: ${shortErr}\n\n` +
          `Silahkan coba lagi dengan mengirim email kamu.`,
      );
    }
    return;
  }

  if (state.step === 'waiting_otp') {
    const otp = text.replace(/\s/g, '');
    if (!/^\d{4,8}$/.test(otp)) {
      await ctx.reply(
        `❌ Format OTP tidak valid. OTP biasanya terdiri dari 4-8 digit angka.\n\nContoh: *123456*`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    setUserState(userId, { step: 'processing' });

    const processingMsg = await ctx.reply(
      `⏳ *Memverifikasi OTP...*\n\n` +
        `🔐 Memasukkan kode OTP...\n` +
        `🌐 Proses login berlangsung...\n\n` +
        `Mohon tunggu, ini bisa memakan waktu 1-2 menit.`,
      { parse_mode: 'Markdown' },
    );

    try {
      const paymentLink = await submitOTP(userId, otp, state.plan || 'plus');

      setUserState(userId, { step: 'waiting_confirmation', paymentLink });

      await ctx.reply(
        `✅ *Login Berhasil!*\n\n` +
          `Proses upgrade sedang berlangsung.\n\n` +
          `💳 Silahkan selesaikan pembayaran pada link berikut:\n` +
          `${paymentLink}\n\n` +
          `Setelah kamu selesai melakukan pembayaran, klik tombol *Sukses* di bawah:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Sukses', 'confirm_success'),
              Markup.button.callback('❌ Batal', 'confirm_cancel'),
            ],
          ]),
        },
      );
    } catch (err) {
      logger.error({ err, userId }, 'Error in submitOTP');
      clearUserState(userId);
      await closeSession(userId);
      const shortErr = String((err as Error).message).slice(0, 200);
      await ctx.reply(
        `❌ Terjadi kesalahan saat memproses OTP.\n\n` +
          `Error: ${shortErr}\n\n` +
          `Silahkan mulai ulang dengan /start`,
      );
    }
    return;
  }

  if (state.step === 'processing') {
    await ctx.reply(`⏳ Sedang memproses, harap tunggu...`);
    return;
  }

  // Default
  await ctx.reply(
    `Ketik /start untuk memulai proses upgrade ChatGPT kamu.`,
  );
});

export default bot;
