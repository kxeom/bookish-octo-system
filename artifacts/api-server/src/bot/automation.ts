import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { generateRandomName, generateRandomBirthdate, generateRandomAge } from './helpers';
import { logger } from '../lib/logger';

export type StatusCallback = (msg: string) => Promise<void>;

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  statusCb: StatusCallback;
}

const sessions = new Map<number, BrowserSession>();

const SYSTEM_CHROMIUM =
  '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium';

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function clickFirst(page: Page, selectors: string[], timeout = 10000): Promise<boolean> {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout, state: 'visible' });
      await page.click(sel);
      return true;
    } catch { /* try next */ }
  }
  return false;
}

async function fillFirst(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      await el.fill(value);
      return true;
    }
  }
  return false;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname.slice(0, 30) : '');
  } catch {
    return url.slice(0, 50);
  }
}

// ─── 1. Start login flow ──────────────────────────────────────────────────────
export async function startLoginFlow(
  userId: number,
  email: string,
  sendStatus: StatusCallback,
): Promise<void> {
  // Close existing session
  const existing = sessions.get(userId);
  if (existing) {
    await existing.browser.close().catch(() => {});
    sessions.delete(userId);
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: SYSTEM_CHROMIUM,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });

  const page = await context.newPage();
  sessions.set(userId, { browser, context, page, statusCb: sendStatus });

  // ── Step 1: Open chatgpt.com ─────────────────────────────────────────────
  await sendStatus('🌐 Membuka chatgpt.com...');
  logger.info({ userId }, 'Navigating to chatgpt.com');

  await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  await sendStatus(`✅ Berada di: ${shortUrl(page.url())}`);

  // ── Step 2: Click the Login button ───────────────────────────────────────
  await sendStatus('🖱️ Mencari dan menekan tombol Login...');

  const loginClicked = await clickFirst(page, [
    'button[data-testid="login-button"]',
    'a[data-testid="login-link"]',
    'button:has-text("Log in")',
    'a:has-text("Log in")',
    'button:has-text("Login")',
    'a:has-text("Login")',
    '[href*="/auth/login"]',
  ], 15000);

  if (!loginClicked) {
    throw new Error('Tombol Login tidak ditemukan di halaman chatgpt.com');
  }

  await sendStatus('✅ Tombol Login ditekan, menunggu form muncul...');
  // Wait for modal to appear
  await page.waitForTimeout(3000);

  // ── Step 3: Detect form — inline modal or redirect to auth page ──────────
  const currentUrl = page.url();
  logger.info({ userId, url: currentUrl }, 'URL after login click');

  // If redirected to auth page (auth0/openai accounts)
  if (/auth0|openai\.com\/|accounts\.|auth\.openai/.test(currentUrl)) {
    await sendStatus(`🔀 Redirect ke: ${shortUrl(currentUrl)}`);
    await handleAuthPage(userId, page, email, sendStatus);
    return;
  }

  // ── Modal inline on chatgpt.com ──────────────────────────────────────────
  // From UI: modal shows "Log in or sign up" with Google/Apple/Phone buttons
  // then an "Email address" input field and "Continue" button
  await sendStatus('📋 Form login muncul...');

  // Wait for the email input in the modal (placeholder: "Email address")
  try {
    await page.waitForSelector(
      'input[placeholder="Email address"], input[placeholder*="email" i], input[placeholder*="Email" i]',
      { timeout: 8000, state: 'visible' },
    );
    await sendStatus('✅ Form email terdeteksi');
  } catch {
    // Maybe there's a "Continue with email" button first
    await sendStatus('🔍 Mencari opsi login dengan email...');
    const emailOptionClicked = await clickFirst(page, [
      'button:has-text("Continue with email")',
      'a:has-text("Continue with email")',
      'button:has-text("Email")',
      '[data-provider="email"]',
    ], 6000);
    if (emailOptionClicked) {
      await sendStatus('✅ Opsi email dipilih');
      await page.waitForTimeout(2000);
    }
  }

  // Fill email in the modal
  await fillEmailOnPage(userId, page, email, sendStatus);
}

// ─── Fill email on current page (Auth0 or inline) ────────────────────────────
async function fillEmailOnPage(
  userId: number,
  page: Page,
  email: string,
  sendStatus: StatusCallback,
): Promise<void> {
  await sendStatus(`📧 Mengisi email: ${email}`);

  const emailSelectors = [
    'input[placeholder="Email address"]',   // ChatGPT inline modal (from screenshot)
    'input[placeholder*="Email" i]',
    'input[placeholder*="email" i]',
    'input[name="username"]',               // Auth0 standard
    'input[name="email"]',
    'input[type="email"]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
    'input[id="username"]',
    'input[id="email"]',
  ];

  let filled = false;
  for (let attempt = 0; attempt < 4 && !filled; attempt++) {
    for (const sel of emailSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 6000, state: 'visible' });
        await page.fill(sel, email);
        filled = true;
        logger.info({ userId, sel }, 'Email filled with selector');
        break;
      } catch { /* try next */ }
    }
    if (!filled) {
      await page.waitForTimeout(2000);
      logger.info({ userId, url: page.url() }, `Email fill attempt ${attempt + 1} failed`);
    }
  }

  if (!filled) {
    const url = page.url();
    const title = await page.title();
    throw new Error(`Form email tidak ditemukan. Halaman: ${title} (${shortUrl(url)})`);
  }

  await sendStatus('🖱️ Menekan tombol Continue...');
  const continueClicked = await clickFirst(page, [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Sign in")',
  ], 10000);

  if (!continueClicked) {
    throw new Error('Tombol Continue tidak ditemukan setelah mengisi email');
  }

  await sendStatus('⏳ Menunggu halaman OTP...');
  logger.info({ userId }, 'Email submitted, waiting for OTP');

  // After Continue, ChatGPT may briefly navigate through /api/auth/* URLs
  // before settling on the OTP page — so we wait and poll rather than just waitForSelector
  const OTP_SELECTORS = [
    'input[name="code"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[maxlength="1"]',
    'input[data-testid*="otp"]',
    'input[data-testid*="code"]',
    'input[placeholder*="code" i]',
    'input[placeholder*="OTP" i]',
    'input[type="number"][maxlength]',
  ];

  let otpFound = false;
  const deadline = Date.now() + 40000; // 40 second total wait

  while (Date.now() < deadline) {
    const url = page.url();
    logger.info({ userId, url }, 'Polling for OTP page');

    // If page navigated to auth0/openai accounts, check there too
    for (const sel of OTP_SELECTORS) {
      const el = await page.$(sel).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        otpFound = true;
        break;
      }
    }

    if (otpFound) break;

    // Also check for "check your email" confirmation text
    const bodyText = await page.$eval('body', (b) => (b as HTMLElement).innerText)
      .catch(() => '');
    if (
      /check your email|we sent|verify your email|enter the code/i.test(bodyText) &&
      !bodyText.includes('Error')
    ) {
      // OTP was sent, input might appear shortly
      await page.waitForTimeout(2000);
      // Try one more time
      for (const sel of OTP_SELECTORS) {
        const el = await page.$(sel).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) {
          otpFound = true;
          break;
        }
      }
      if (otpFound) break;
    }

    await page.waitForTimeout(2000);
  }

  if (!otpFound) {
    const url = page.url();
    const errorText = await page.$eval(
      '[class*="error"], [role="alert"], .alert',
      (el) => (el as HTMLElement).innerText,
    ).catch(() => '');
    const detail = errorText ? ` Pesan error: "${errorText.slice(0, 120)}"` : '';
    throw new Error(
      `Halaman OTP tidak muncul setelah 40 detik.\nURL terakhir: ${shortUrl(url)}${detail}\n\nKemungkinan: email tidak valid, terkena rate limit, atau ChatGPT memblokir akses.`,
    );
  }

  const otpUrl = page.url();
  await sendStatus(`✅ Berada di: ${shortUrl(otpUrl)}`);
}

// ─── Handle Auth0 / OpenAI account page ──────────────────────────────────────
async function handleAuthPage(
  userId: number,
  page: Page,
  email: string,
  sendStatus: StatusCallback,
): Promise<void> {
  // May need to click "Continue with email" if SSO options shown
  const emailOptionClicked = await clickFirst(page, [
    'button:has-text("Continue with email")',
    'a:has-text("Continue with email")',
    'button:has-text("Email")',
    '[data-provider="email"]',
  ], 5000);

  if (emailOptionClicked) {
    await sendStatus('✅ Opsi email dipilih');
    await page.waitForTimeout(2000);
  }

  await fillEmailOnPage(userId, page, email, sendStatus);
}

// ─── 2. Submit OTP ────────────────────────────────────────────────────────────
export async function submitOTP(
  userId: number,
  otp: string,
  plan: string,
): Promise<string> {
  const session = sessions.get(userId);
  if (!session) throw new Error('Sesi browser tidak ditemukan. Mulai ulang dengan /start');

  const { page, statusCb: sendStatus } = session;

  await sendStatus(`🔐 Memasukkan kode OTP: ${otp}`);
  logger.info({ userId }, 'Submitting OTP');

  // Single field (e.g. input[name="code"])
  const singleField = await page.$('input[name="code"], input[autocomplete="one-time-code"]');
  if (singleField && await singleField.isVisible().catch(() => false)) {
    await singleField.fill(otp);
    logger.info({ userId }, 'Filled single OTP field');
  } else {
    // Individual digit boxes
    const digits = await page.$$('input[maxlength="1"]');
    if (digits.length > 0) {
      for (let i = 0; i < digits.length && i < otp.length; i++) {
        await digits[i].click();
        await digits[i].fill(otp[i]);
        await page.waitForTimeout(80);
      }
      logger.info({ userId, count: digits.length }, 'Filled digit OTP boxes');
    } else {
      await page.keyboard.type(otp, { delay: 80 });
      logger.info({ userId }, 'Typed OTP via keyboard');
    }
  }

  // Submit OTP
  await clickFirst(page, [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Verify")',
    'button:has-text("Confirm")',
  ], 8000).catch(() => { /* may auto-submit */ });

  await sendStatus('🔄 OTP dikirim, menunggu redirect...');

  // Wait for chatgpt.com
  try {
    await page.waitForURL(/chatgpt\.com/, { timeout: 25000 });
  } catch {
    logger.warn({ userId, url: page.url() }, 'Timeout waiting for chatgpt.com redirect');
  }

  await page.waitForTimeout(3000);
  await sendStatus(`✅ Berada di: ${shortUrl(page.url())}`);

  // Handle new account
  await handleNewAccountFlow(userId, page, sendStatus);

  // Make sure we are on chatgpt.com
  if (!page.url().startsWith('https://chatgpt.com')) {
    await sendStatus('🌐 Kembali ke chatgpt.com...');
    await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
  }

  await sendStatus('✅ Login berhasil! Mengambil session token...');
  const sessionToken = await extractSession(page);
  await sendStatus('✅ Session token berhasil diambil');

  await sendStatus(`💳 Membuat link checkout untuk paket ${plan}...`);
  const checkoutUrl = await callPaymentAPI(sessionToken, plan);
  await sendStatus('✅ Link checkout berhasil dibuat');

  await sendStatus('🛒 Membuka halaman checkout...');
  const paymentLink = await processCheckout(userId, page, checkoutUrl, sendStatus);

  return paymentLink;
}

// ─── Handle new account (name / birthday / age) ───────────────────────────────
async function handleNewAccountFlow(
  userId: number,
  page: Page,
  sendStatus: StatusCallback,
): Promise<void> {
  const nameInput = await page.$('input[name="name"], input[id="name"]');
  if (nameInput && await nameInput.isVisible().catch(() => false)) {
    const randomName = generateRandomName();
    await nameInput.fill(randomName);
    await sendStatus(`📝 Akun baru terdeteksi, mengisi nama: ${randomName}`);
    await clickFirst(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")'], 8000).catch(() => {});
    await page.waitForTimeout(2000);
  }

  const ageInput = await page.$('input[type="number"], input[name="age"]');
  if (ageInput && await ageInput.isVisible().catch(() => false)) {
    const age = generateRandomAge();
    await ageInput.fill(age);
    await sendStatus(`📅 Mengisi umur: ${age}`);
    await clickFirst(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")'], 8000).catch(() => {});
    await page.waitForTimeout(2000);
  }

  const dateInput = await page.$('input[type="date"], input[name="birthdate"]');
  if (dateInput && await dateInput.isVisible().catch(() => false)) {
    const { month, day, year } = generateRandomBirthdate();
    await dateInput.fill(`${year}-${month}-${day}`);
    await sendStatus(`📅 Mengisi tanggal lahir: ${day}/${month}/${year}`);
    await clickFirst(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")'], 8000).catch(() => {});
    await page.waitForTimeout(2000);
  }

  const monthSel = await page.$('select[name="month"]');
  const daySel = await page.$('select[name="day"]');
  const yearSel = await page.$('select[name="year"]');
  if (monthSel && daySel && yearSel) {
    const { month, day, year } = generateRandomBirthdate();
    await monthSel.selectOption({ value: month });
    await daySel.selectOption({ value: day });
    await yearSel.selectOption({ value: year });
    await sendStatus(`📅 Mengisi tanggal lahir: ${day}/${month}/${year}`);
    await clickFirst(page, ['button[type="submit"]', 'button:has-text("Continue")'], 8000).catch(() => {});
    await page.waitForTimeout(2000);
  }
}

// ─── Extract session ──────────────────────────────────────────────────────────
async function extractSession(page: Page): Promise<string> {
  await page.goto('https://chatgpt.com/api/auth/session', {
    waitUntil: 'networkidle',
    timeout: 20000,
  });

  const bodyText = await page.textContent('body');
  if (!bodyText?.trim()) throw new Error('Session body kosong');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error('Gagal parse session JSON');
  }

  const token = (parsed['accessToken'] as string) || (parsed['token'] as string);
  if (!token) throw new Error(`Session token tidak ditemukan. Keys: ${Object.keys(parsed).join(', ')}`);

  return token;
}

// ─── Call payment API ─────────────────────────────────────────────────────────
async function callPaymentAPI(session: string, plan: string): Promise<string> {
  const resp = await fetch('https://ezweystock.petrix.id/gpt/payment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36',
      Referer: 'https://ezweystock.petrix.id/gpt/',
    },
    body: JSON.stringify({
      plan: plan.toLowerCase(),
      payment: 'shortlink',
      currency: 'Indonesia',
      session,
    }),
  });

  const data = (await resp.json()) as { success: boolean; url?: string; error?: string };
  if (!data.success || !data.url) {
    throw new Error(`Payment API gagal: ${data.error ?? JSON.stringify(data)}`);
  }
  return data.url;
}

// ─── Process checkout ─────────────────────────────────────────────────────────
async function processCheckout(
  userId: number,
  page: Page,
  checkoutUrl: string,
  sendStatus: StatusCallback,
): Promise<string> {
  await sendStatus(`🔀 Berada di: ${shortUrl(checkoutUrl)}`);
  await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  await sendStatus(`✅ Berada di: ${shortUrl(page.url())}`);

  // Select GoPay
  await sendStatus('💳 Memilih metode pembayaran GoPay...');
  const gopayClicked = await clickFirst(page, [
    'text=GoPay',
    'label:has-text("GoPay")',
    '[data-value*="gopay"]',
    'button:has-text("GoPay")',
    '[aria-label*="GoPay"]',
    'div:has-text("GoPay")',
  ], 8000);

  if (gopayClicked) {
    await sendStatus('✅ GoPay dipilih');
  } else {
    await sendStatus('⚠️ GoPay tidak ditemukan, melanjutkan...');
  }

  await page.waitForTimeout(2000);

  // Fill address
  const addrFilled = await fillFirst(page, [
    'input[placeholder*="address" i]',
    'input[name="address"]',
    'input[autocomplete="street-address"]',
    'input[placeholder*="alamat" i]',
  ], 'Jl. Sudirman No. 123, Jakarta Pusat');

  if (addrFilled) await sendStatus('📍 Alamat diisi otomatis');

  await page.waitForTimeout(1000);

  // Click Subscribe
  await sendStatus('🖱️ Menekan tombol Subscribe...');
  const subscribeClicked = await clickFirst(page, [
    'button:has-text("Subscribe")',
    'button:has-text("Berlangganan")',
    'button[type="submit"]:has-text("Subscribe")',
    'button[type="submit"]',
  ], 10000);

  if (subscribeClicked) {
    await sendStatus('✅ Tombol Subscribe ditekan, menunggu redirect...');
  }

  await page.waitForTimeout(6000);

  const finalUrl = page.url();
  await sendStatus(`✅ Berada di: ${shortUrl(finalUrl)}`);
  logger.info({ userId, finalUrl }, 'Final URL after subscribe');

  return finalUrl;
}

// ─── Close session ────────────────────────────────────────────────────────────
export async function closeSession(userId: number): Promise<void> {
  const s = sessions.get(userId);
  if (s) {
    await s.browser.close().catch(() => {});
    sessions.delete(userId);
    logger.info({ userId }, 'Browser session closed');
  }
}
