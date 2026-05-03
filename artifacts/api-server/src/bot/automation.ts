import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { generateRandomName, generateRandomBirthdate, generateRandomAge } from './helpers';
import { logger } from '../lib/logger';

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const sessions = new Map<number, BrowserSession>();

// Use system-installed Chromium (avoids missing libgbm / shared lib issues)
const SYSTEM_CHROMIUM =
  '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium';

async function getPage(userId: number): Promise<Page> {
  const s = sessions.get(userId);
  if (!s) throw new Error('Sesi browser tidak ditemukan. Mulai ulang dengan /start');
  return s.page;
}

// ─── Helper: click first matching selector ────────────────────────────────────
async function clickFirst(page: Page, selectors: string[], timeout = 10000): Promise<boolean> {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout, state: 'visible' });
      await page.click(sel);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

// ─── Helper: fill first matching selector ─────────────────────────────────────
async function fillFirst(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el && await el.isVisible().catch(() => false)) {
      await el.fill(value);
      return true;
    }
  }
  return false;
}

// ─── 1. Start login flow ──────────────────────────────────────────────────────
export async function startLoginFlow(userId: number, email: string): Promise<void> {
  // Close any existing session
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
  sessions.set(userId, { browser, context, page });

  logger.info({ userId, email }, 'Opening chatgpt.com');

  // ── Navigate to chatgpt.com login directly ───────────────────────────────
  await page.goto('https://chatgpt.com/auth/login', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(2000);

  logger.info({ userId, url: page.url() }, 'Landed on page');

  // ── If still on chatgpt.com, click the Log in button ────────────────────
  if (page.url().includes('chatgpt.com') && !page.url().includes('auth0') && !page.url().includes('openai.com/')) {
    const clicked = await clickFirst(page, [
      'button[data-testid="login-button"]',
      'a[href*="/auth/login"]',
      'button:has-text("Log in")',
      'a:has-text("Log in")',
      'button:has-text("Login")',
    ], 10000);
    logger.info({ userId, clicked }, 'Clicked login button');
    await page.waitForTimeout(2000);
  }

  // ── Wait until we reach the Auth0 / OpenAI auth page ────────────────────
  try {
    await page.waitForURL(/auth0|openai\.com|accounts\.openai|auth\.openai/, {
      timeout: 15000,
    });
  } catch {
    // maybe already on auth page or chatgpt.com handled it inline
  }

  logger.info({ userId, url: page.url() }, 'On auth page');

  // ── Fill email — Auth0 uses name="username" ──────────────────────────────
  const emailSelectors = [
    'input[name="username"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
    'input[id="username"]',
    'input[id="email"]',
  ];

  let emailFilled = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const sel of emailSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 8000, state: 'visible' });
        await page.fill(sel, email);
        emailFilled = true;
        logger.info({ userId, sel }, 'Email filled');
        break;
      } catch {
        // next selector
      }
    }
    if (emailFilled) break;
    await page.waitForTimeout(2000);
  }

  if (!emailFilled) {
    const url = page.url();
    const title = await page.title();
    throw new Error(`Tidak bisa menemukan form email. URL: ${url}, Title: ${title}`);
  }

  // ── Submit email ─────────────────────────────────────────────────────────
  await clickFirst(page, [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Sign in")',
  ], 10000);

  logger.info({ userId }, 'Email submitted, waiting for OTP page');

  // ── Wait for OTP step to appear ──────────────────────────────────────────
  try {
    await page.waitForSelector(
      'input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="1"]',
      { timeout: 30000 },
    );
    logger.info({ userId }, 'OTP input detected');
  } catch {
    const url = page.url();
    logger.warn({ userId, url }, 'OTP input not found, user may check manually');
  }
}

// ─── 2. Submit OTP ────────────────────────────────────────────────────────────
export async function submitOTP(
  userId: number,
  otp: string,
  plan: string,
): Promise<string> {
  const page = await getPage(userId);

  logger.info({ userId, url: page.url() }, 'Submitting OTP');

  // Try single OTP field (e.g. input[name="code"])
  const singleField = await page.$(
    'input[name="code"], input[autocomplete="one-time-code"]',
  );

  if (singleField && await singleField.isVisible().catch(() => false)) {
    await singleField.fill(otp);
    logger.info({ userId }, 'Filled single OTP field');
  } else {
    // Individual digit boxes (maxlength=1)
    const digits = await page.$$('input[maxlength="1"]');
    if (digits.length > 0) {
      for (let i = 0; i < digits.length && i < otp.length; i++) {
        await digits[i].click();
        await digits[i].fill(otp[i]);
        await page.waitForTimeout(100);
      }
      logger.info({ userId, count: digits.length }, 'Filled digit OTP boxes');
    } else {
      // Last resort: focus page and type
      await page.keyboard.type(otp, { delay: 80 });
      logger.info({ userId }, 'Typed OTP via keyboard');
    }
  }

  // Submit OTP form
  await clickFirst(page, [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Verify")',
    'button:has-text("Confirm")',
  ], 8000).catch(() => {
    // maybe auto-submit after last digit
  });

  logger.info({ userId }, 'OTP submitted, waiting for redirect');

  // ── Wait for redirect back to chatgpt.com ────────────────────────────────
  try {
    await page.waitForURL(/chatgpt\.com/, { timeout: 25000 });
  } catch {
    logger.warn({ userId, url: page.url() }, 'Still not on chatgpt.com');
  }

  await page.waitForTimeout(3000);
  logger.info({ userId, url: page.url() }, 'After OTP redirect');

  // ── Handle new account flow ──────────────────────────────────────────────
  await handleNewAccountFlow(userId, page);

  // ── Make sure we are on chatgpt.com home ────────────────────────────────
  if (!page.url().startsWith('https://chatgpt.com')) {
    await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
  }

  logger.info({ userId }, 'Logged in. Extracting session...');

  // ── Get session ──────────────────────────────────────────────────────────
  const sessionToken = await extractSession(page);
  logger.info({ userId }, 'Session extracted');

  // ── Call payment API ─────────────────────────────────────────────────────
  const checkoutUrl = await callPaymentAPI(sessionToken, plan);
  logger.info({ userId, checkoutUrl }, 'Checkout URL received');

  // ── Process checkout ─────────────────────────────────────────────────────
  const paymentLink = await processCheckout(userId, page, checkoutUrl);

  return paymentLink;
}

// ─── Handle new account (name / birthday / age) ───────────────────────────────
async function handleNewAccountFlow(userId: number, page: Page): Promise<void> {
  // Check for name input (new account)
  const nameInput = await page.$('input[name="name"], input[id="name"]');
  if (nameInput && await nameInput.isVisible().catch(() => false)) {
    const randomName = generateRandomName();
    await nameInput.fill(randomName);
    logger.info({ userId, randomName }, 'Filled name for new account');
    await clickFirst(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")'], 8000).catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Check for age input
  const ageInput = await page.$('input[type="number"], input[name="age"]');
  if (ageInput && await ageInput.isVisible().catch(() => false)) {
    const age = generateRandomAge();
    await ageInput.fill(age);
    logger.info({ userId, age }, 'Filled age');
    await clickFirst(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")'], 8000).catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Check for birthdate input
  const dateInput = await page.$('input[type="date"], input[name="birthdate"]');
  if (dateInput && await dateInput.isVisible().catch(() => false)) {
    const { month, day, year } = generateRandomBirthdate();
    await dateInput.fill(`${year}-${month}-${day}`);
    logger.info({ userId }, 'Filled birthdate');
    await clickFirst(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")'], 8000).catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Check for separate month/day/year selects
  const monthSel = await page.$('select[name="month"]');
  const daySel = await page.$('select[name="day"]');
  const yearSel = await page.$('select[name="year"]');
  if (monthSel && daySel && yearSel) {
    const { month, day, year } = generateRandomBirthdate();
    await monthSel.selectOption({ value: month });
    await daySel.selectOption({ value: day });
    await yearSel.selectOption({ value: year });
    logger.info({ userId }, 'Filled birthdate via selects');
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
  if (!bodyText || bodyText.trim() === '') throw new Error('Session body kosong');

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
async function processCheckout(userId: number, page: Page, checkoutUrl: string): Promise<string> {
  logger.info({ userId, checkoutUrl }, 'Opening checkout');

  await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Select GoPay
  const gopayClicked = await clickFirst(page, [
    'text=GoPay',
    'label:has-text("GoPay")',
    '[data-value*="gopay"]',
    '[data-payment-method*="gopay"]',
    'button:has-text("GoPay")',
    '[aria-label*="GoPay"]',
    'div:has-text("GoPay")',
  ], 8000);
  logger.info({ userId, gopayClicked }, 'GoPay click attempted');
  await page.waitForTimeout(2000);

  // Fill address if visible
  const addrFilled = await fillFirst(page, [
    'input[placeholder*="address" i]',
    'input[name="address"]',
    'input[autocomplete="street-address"]',
    'input[placeholder*="alamat" i]',
  ], 'Jl. Sudirman No. 123, Jakarta Pusat');
  if (addrFilled) logger.info({ userId }, 'Address filled');

  await page.waitForTimeout(1000);

  // Click Subscribe
  const subscribeClicked = await clickFirst(page, [
    'button:has-text("Subscribe")',
    'button:has-text("Berlangganan")',
    'button[type="submit"]:has-text("Subscribe")',
    'button[type="submit"]',
  ], 10000);
  logger.info({ userId, subscribeClicked }, 'Subscribe clicked');

  // Wait for redirect after subscribe
  await page.waitForTimeout(6000);

  const finalUrl = page.url();
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
