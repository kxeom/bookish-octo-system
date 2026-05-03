import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { generateRandomName, generateRandomBirthdate, generateRandomAge } from './helpers';
import { logger } from '../lib/logger';

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const sessions = new Map<number, BrowserSession>();

export async function startLoginFlow(userId: number, email: string): Promise<void> {
  const existing = sessions.get(userId);
  if (existing) {
    await existing.browser.close().catch(() => {});
    sessions.delete(userId);
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });

  const page = await context.newPage();
  sessions.set(userId, { browser, context, page });

  logger.info({ userId, email }, 'Starting ChatGPT login automation');

  await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Click login button
  await page.waitForSelector(
    'button[data-testid="login-button"], a[href*="login"], button:has-text("Log in"), a:has-text("Log in")',
    { timeout: 15000 },
  );
  await page.click(
    'button[data-testid="login-button"], a[href*="login"], button:has-text("Log in"), a:has-text("Log in")',
  );

  // Wait for email input
  await page.waitForSelector(
    'input[name="email"], input[type="email"], input[autocomplete="email"]',
    { timeout: 20000 },
  );
  await page.fill(
    'input[name="email"], input[type="email"], input[autocomplete="email"]',
    email,
  );

  // Submit email
  await page.click(
    'button[type="submit"], button:has-text("Continue"), button:has-text("Next")',
  );

  logger.info({ userId }, 'Email submitted, waiting for OTP');
}

export async function submitOTP(
  userId: number,
  otp: string,
  plan: string,
): Promise<string> {
  const session = sessions.get(userId);
  if (!session) throw new Error('Sesi browser tidak ditemukan. Mulai ulang dengan /start');

  const { page } = session;

  logger.info({ userId }, 'Submitting OTP');

  // Enter OTP - it might be individual digit boxes or one field
  try {
    // Try single OTP field first
    const singleOtp = await page.$(
      'input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]',
    );
    if (singleOtp) {
      await singleOtp.fill(otp);
      await page.click('button[type="submit"], button:has-text("Continue"), button:has-text("Verify")').catch(() => {});
    } else {
      // Individual digit boxes
      const digits = await page.$$('input[maxlength="1"]');
      for (let i = 0; i < digits.length && i < otp.length; i++) {
        await digits[i].fill(otp[i]);
      }
    }
  } catch {
    // Try typing OTP directly
    await page.keyboard.type(otp);
    await page.keyboard.press('Enter');
  }

  // Wait for navigation after OTP
  await page.waitForTimeout(4000);

  const currentUrl = page.url();
  logger.info({ userId, url: currentUrl }, 'URL after OTP');

  // Handle new account flow (name/birthday)
  const needsName = await page
    .$('input[name="name"], input[placeholder*="name"], input[placeholder*="Name"]')
    .then((el) => !!el)
    .catch(() => false);

  const needsAge = await page
    .$('input[type="number"][max="120"], input[placeholder*="age"], input[name="age"]')
    .then((el) => !!el)
    .catch(() => false);

  const needsBirthdate = await page
    .$('input[name="birthdate"], input[type="date"], [placeholder*="birth"]')
    .then((el) => !!el)
    .catch(() => false);

  if (needsName) {
    logger.info({ userId }, 'New account detected - filling name');
    const randomName = generateRandomName();
    await page.fill(
      'input[name="name"], input[placeholder*="name"], input[placeholder*="Name"]',
      randomName,
    );
    await page.click('button[type="submit"], button:has-text("Continue"), button:has-text("Next")').catch(() => {});
    await page.waitForTimeout(2000);
  }

  if (needsAge) {
    const age = generateRandomAge();
    await page.fill(
      'input[type="number"][max="120"], input[placeholder*="age"], input[name="age"]',
      age,
    );
    await page.click('button[type="submit"], button:has-text("Continue"), button:has-text("Next")').catch(() => {});
    await page.waitForTimeout(2000);
  }

  if (needsBirthdate) {
    const { month, day, year } = generateRandomBirthdate();
    // Try individual fields
    const monthInput = await page.$('select[name="month"], input[name="month"], input[placeholder*="month"]');
    const dayInput = await page.$('select[name="day"], input[name="day"], input[placeholder*="day"]');
    const yearInput = await page.$('select[name="year"], input[name="year"], input[placeholder*="year"]');
    if (monthInput && dayInput && yearInput) {
      await monthInput.fill(month);
      await dayInput.fill(day);
      await yearInput.fill(year);
    } else {
      // Try single date input
      const dateInput = await page.$('input[name="birthdate"], input[type="date"]');
      if (dateInput) {
        await dateInput.fill(`${year}-${month}-${day}`);
      }
    }
    await page.click('button[type="submit"], button:has-text("Continue"), button:has-text("Next")').catch(() => {});
    await page.waitForTimeout(3000);
  }

  // Wait until we reach chatgpt.com home
  await page
    .waitForURL('https://chatgpt.com/**', { timeout: 20000 })
    .catch(() => logger.warn({ userId }, 'Timeout waiting for chatgpt.com'));

  logger.info({ userId }, 'Logged in successfully, extracting session');

  // Get session token
  const sessionData = await extractSession(page);

  logger.info({ userId }, 'Session extracted, calling payment API');

  // Call payment API
  const checkoutUrl = await callPaymentAPI(sessionData, plan);

  logger.info({ userId, checkoutUrl }, 'Checkout URL obtained');

  // Open checkout and process payment
  const paymentLink = await processCheckout(userId, page, checkoutUrl);

  return paymentLink;
}

async function extractSession(page: Page): Promise<string> {
  await page.goto('https://chatgpt.com/api/auth/session', {
    waitUntil: 'networkidle',
    timeout: 15000,
  });

  const bodyText = await page.textContent('body');
  if (!bodyText) throw new Error('Gagal mengambil session data');

  const sessionData = JSON.parse(bodyText);

  // The session token we need
  const accessToken =
    sessionData.accessToken ||
    sessionData.token ||
    JSON.stringify(sessionData);

  if (!accessToken) throw new Error('Session token tidak ditemukan');

  return accessToken;
}

async function callPaymentAPI(session: string, plan: string): Promise<string> {
  const response = await fetch('https://ezweystock.petrix.id/gpt/payment', {
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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Payment API error: ${response.status} - ${text}`);
  }

  const data = (await response.json()) as { success: boolean; url?: string; error?: string };
  if (!data.success || !data.url) {
    throw new Error(`Payment API gagal: ${data.error || JSON.stringify(data)}`);
  }

  return data.url;
}

async function processCheckout(
  userId: number,
  page: Page,
  checkoutUrl: string,
): Promise<string> {
  logger.info({ userId, checkoutUrl }, 'Opening checkout page');

  await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Select GoPay payment method
  try {
    const gopaySelectors = [
      'text=GoPay',
      '[data-payment-method*="gopay"]',
      'label:has-text("GoPay")',
      'button:has-text("GoPay")',
      '[aria-label*="GoPay"]',
    ];
    for (const sel of gopaySelectors) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        await el.click();
        logger.info({ userId }, 'GoPay selected');
        break;
      }
    }
  } catch {
    logger.warn({ userId }, 'Could not select GoPay, continuing');
  }

  await page.waitForTimeout(2000);

  // Fill address if needed
  const addressField = await page
    .$('input[placeholder*="address"], input[name="address"], input[autocomplete="street-address"]')
    .catch(() => null);

  if (addressField) {
    const randomAddresses = [
      'Jl. Sudirman No. 123, Jakarta Pusat',
      'Jl. Thamrin No. 45, Jakarta',
      'Jl. Gatot Subroto No. 67, Jakarta Selatan',
      'Jl. Kuningan No. 89, Jakarta',
    ];
    const addr = randomAddresses[Math.floor(Math.random() * randomAddresses.length)];
    await addressField.fill(addr);
  }

  // Check total is 0
  const totalText = await page.textContent(
    '[data-testid="total"], .total-amount, text=/Rp 0|IDR 0|0\.00/',
  ).catch(() => '');
  logger.info({ userId, totalText }, 'Total amount on checkout');

  await page.waitForTimeout(1000);

  // Click subscribe button
  const subscribeSelectors = [
    'button:has-text("Subscribe")',
    'button:has-text("Berlangganan")',
    'button[type="submit"]:has-text("Subscribe")',
    'button[type="submit"]',
  ];

  for (const sel of subscribeSelectors) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) {
      await btn.click();
      logger.info({ userId }, 'Subscribe button clicked');
      break;
    }
  }

  // Wait for redirect
  await page.waitForTimeout(5000);

  const finalUrl = page.url();
  logger.info({ userId, finalUrl }, 'Final URL after subscribe');

  return finalUrl;
}

export async function closeSession(userId: number): Promise<void> {
  const session = sessions.get(userId);
  if (session) {
    await session.browser.close().catch(() => {});
    sessions.delete(userId);
    logger.info({ userId }, 'Browser session closed');
  }
}
