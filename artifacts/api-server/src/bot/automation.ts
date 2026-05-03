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

// ─── Stealth init script (injected before every page load) ───────────────────
// Hides all Playwright/CDP automation indicators from the page's JavaScript
const STEALTH_SCRIPT = `
(function () {
  // 1. Hide webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

  // 2. Fake plugins (real browsers have plugins)
  const fakePlugins = [
    { name: 'Chrome PDF Plugin',     filename: 'internal-pdf-viewer',    description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer',     filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Native Client',         filename: 'internal-nacl-plugin',   description: '' },
  ];
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const arr = fakePlugins.map((p) => {
        const plugin = Object.create(Plugin.prototype);
        Object.defineProperty(plugin, 'name',        { get: () => p.name });
        Object.defineProperty(plugin, 'filename',    { get: () => p.filename });
        Object.defineProperty(plugin, 'description', { get: () => p.description });
        Object.defineProperty(plugin, 'length',      { get: () => 0 });
        return plugin;
      });
      arr.item   = (i) => arr[i];
      arr.namedItem = (n) => arr.find((p) => p.name === n) ?? null;
      arr.refresh   = () => {};
      Object.defineProperty(arr, 'length', { get: () => fakePlugins.length });
      return arr;
    },
    configurable: true,
  });

  // 3. Languages
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });

  // 4. Add window.chrome (missing in headless)
  if (!window.chrome) {
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} };
  }

  // 5. Permissions API — real browsers don't expose automation state
  const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
  window.navigator.permissions.query = (params) => {
    if (params && params.name === 'notifications') {
      return Promise.resolve(Object.assign(Object.create(PermissionStatus.prototype), {
        state: 'default', onchange: null,
      }));
    }
    return origQuery(params);
  };

  // 6. Randomise canvas fingerprint slightly (avoids canvas-based bot detection)
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const shift = { r: Math.floor(Math.random() * 3) - 1, g: Math.floor(Math.random() * 3) - 1, b: Math.floor(Math.random() * 3) - 1 };
      const imgData = ctx.getImageData(0, 0, this.width || 1, this.height || 1);
      for (let i = 0; i < imgData.data.length; i += 4) {
        imgData.data[i]     = Math.min(255, Math.max(0, imgData.data[i]     + shift.r));
        imgData.data[i + 1] = Math.min(255, Math.max(0, imgData.data[i + 1] + shift.g));
        imgData.data[i + 2] = Math.min(255, Math.max(0, imgData.data[i + 2] + shift.b));
      }
      ctx.putImageData(imgData, 0, 0);
    }
    return origToDataURL.apply(this, args);
  };

  // 7. Hardware concurrency — realistic value
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });

  // 8. Hide Playwright-specific properties
  const deleteProps = ['__playwright', '__pwInitScripts', '__pw_manual', 'playwright'];
  deleteProps.forEach((p) => { try { delete (window as any)[p]; } catch {} });
})();
`;

// ─── Utility helpers ──────────────────────────────────────────────────────────
function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname.slice(0, 40) : '');
  } catch {
    return url.slice(0, 60);
  }
}

// ─── Human-like mouse click ───────────────────────────────────────────────────
// Moves mouse to a random spot first, then to the element, then clicks
async function humanClick(page: Page, selector: string, timeout = 12000): Promise<void> {
  await page.waitForSelector(selector, { state: 'visible', timeout });
  const el = await page.$(selector);
  if (!el) throw new Error(`Element tidak ditemukan: ${selector}`);

  const box = await el.boundingBox();
  if (!box) throw new Error(`Tidak bisa dapat posisi elemen: ${selector}`);

  // Move to a random corner of screen first
  await page.mouse.move(rand(0, 300), rand(0, 300), { steps: rand(5, 15) });
  await sleep(rand(80, 200));

  // Move toward element with slight random offset (not perfectly centered)
  const targetX = box.x + box.width  * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);
  await page.mouse.move(targetX, targetY, { steps: rand(10, 25) });
  await sleep(rand(50, 150));

  // Click
  await page.mouse.click(targetX, targetY);
}

// ─── Human-like typing ────────────────────────────────────────────────────────
// Types character by character with random delays, like a real person
async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
  await humanClick(page, selector, 5000);
  await sleep(rand(100, 300));

  for (const char of text) {
    await page.keyboard.type(char);
    await sleep(rand(60, 180));
    // Occasional micro-pause like a real typist
    if (Math.random() < 0.08) await sleep(rand(200, 500));
  }
}

// ─── Wait for selector with multiple fallbacks ────────────────────────────────
async function waitAndClick(
  page: Page,
  selectors: string[],
  timeout = 12000,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible().catch(() => false)) {
          await humanClick(page, sel, 5000);
          return true;
        }
      } catch { /* try next */ }
    }
    await sleep(500);
  }
  return false;
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

  // ── Launch Chromium with stealth args ─────────────────────────────────────
  const browser = await chromium.launch({
    headless: true,
    executablePath: SYSTEM_CHROMIUM,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      // Anti-bot detection flags
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--metrics-recording-only',
      '--use-mock-keychain',
      '--ignore-certificate-errors',
      '--allow-running-insecure-content',
      '--window-size=1366,768',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // ── Create context with realistic fingerprint ─────────────────────────────
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'light',
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  });

  // Inject stealth script before every page load
  await context.addInitScript(STEALTH_SCRIPT);

  const page = await context.newPage();
  sessions.set(userId, { browser, context, page, statusCb: sendStatus });

  // ── Step 1: Open chatgpt.com ─────────────────────────────────────────────
  await sendStatus('🌐 Membuka chatgpt.com...');
  logger.info({ userId }, 'Navigating to chatgpt.com');

  await page.goto('https://chatgpt.com', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // Wait a bit — behave like a human who just loaded the page
  await sleep(rand(2000, 4000));

  // Small random mouse movement to simulate human browsing
  await page.mouse.move(rand(400, 900), rand(200, 500), { steps: rand(10, 20) });
  await sleep(rand(500, 1200));

  await sendStatus(`✅ Berada di: ${shortUrl(page.url())}`);

  // ── Step 2: Click the Login button ───────────────────────────────────────
  await sendStatus('🖱️ Mencari tombol Login...');
  const loginClicked = await waitAndClick(page, [
    'button[data-testid="login-button"]',
    'a[data-testid="login-link"]',
    'button:has-text("Log in")',
    'a:has-text("Log in")',
    'button:has-text("Login")',
    'a:has-text("Login")',
  ], 15000);

  if (!loginClicked) {
    throw new Error('Tombol Login tidak ditemukan di chatgpt.com');
  }

  await sendStatus('✅ Tombol Login ditekan, menunggu modal...');
  // Wait for modal to appear and JS to settle
  await sleep(rand(2500, 4000));

  // ── Step 3: Handle flow after login click ─────────────────────────────────
  const urlAfterLogin = page.url();
  logger.info({ userId, url: urlAfterLogin }, 'URL after login click');

  // If immediately redirected to auth page (sometimes happens)
  if (urlAfterLogin.includes('auth.openai.com') || urlAfterLogin.includes('auth0')) {
    await sendStatus(`🔀 Redirect ke: ${shortUrl(urlAfterLogin)}`);
  }

  // ── Step 4: Fill email in modal ───────────────────────────────────────────
  await sendStatus(`📧 Mengisi email: ${email}`);

  const emailSelectors = [
    'input[placeholder="Email address"]',
    'input[placeholder*="email" i]',
    'input[name="username"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
  ];

  let emailFilled = false;
  for (let attempt = 0; attempt < 5 && !emailFilled; attempt++) {
    for (const sel of emailSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible().catch(() => false)) {
          await humanType(page, sel, email);
          emailFilled = true;
          logger.info({ userId, sel }, 'Email typed human-like');
          break;
        }
      } catch { /* try next */ }
    }
    if (!emailFilled) {
      await sleep(rand(1500, 2500));
      logger.info({ userId, attempt }, 'Email input not found yet, retrying');
    }
  }

  if (!emailFilled) {
    const title = await page.title().catch(() => '');
    throw new Error(`Form email tidak ditemukan. Halaman: ${title} (${shortUrl(page.url())})`);
  }

  // Short pause before clicking — humans don't instantly click after typing
  await sleep(rand(400, 900));

  // ── Step 5: Click Continue ────────────────────────────────────────────────
  await sendStatus('🖱️ Menekan tombol Continue...');

  const continueClicked = await waitAndClick(page, [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Sign in")',
  ], 12000);

  if (!continueClicked) {
    throw new Error('Tombol Continue tidak ditemukan setelah mengisi email');
  }

  await sendStatus('⏳ Menunggu redirect ke halaman OTP...');
  logger.info({ userId }, 'Continue clicked, waiting for auth.openai.com');

  // ── Step 6: Wait for redirect to auth.openai.com/email-verification ───────
  try {
    await page.waitForURL(
      (url) =>
        url.hostname.includes('auth.openai.com') ||
        url.pathname.includes('email-verification'),
      { timeout: 20000 },
    );
  } catch {
    logger.warn({ userId, url: page.url() }, 'waitForURL auth.openai.com timed out');
  }

  const afterUrl = page.url();
  logger.info({ userId, url: afterUrl }, 'URL after Continue');

  // Hard stop if auth error
  if (afterUrl.includes('/api/auth/error')) {
    const errorPageText = await page.$eval('body', (b) => (b as HTMLElement).innerText)
      .catch(() => '');
    const hint = errorPageText.slice(0, 200);
    throw new Error(`Login ditolak ChatGPT (auth/error).\nDetail: ${hint}`);
  }

  await sendStatus(`✅ Redirect ke: ${shortUrl(afterUrl)}`);

  // ── Step 7: Find OTP input ────────────────────────────────────────────────
  const OTP_SELECTORS = [
    'input[autocomplete="one-time-code"]',
    'input[name="code"]',
    'input[inputmode="numeric"]',
    'input[maxlength="1"]',
    'input[maxlength="6"]',
    'input[data-testid*="otp"]',
    'input[data-testid*="code"]',
    'input[placeholder*="code" i]',
    'input[type="text"]',
  ];

  let otpFound = false;
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline && !otpFound) {
    for (const sel of OTP_SELECTORS) {
      const el = await page.$(sel).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        logger.info({ userId, sel }, 'OTP input found');
        otpFound = true;
        break;
      }
    }
    if (!otpFound) await sleep(2000);
  }

  if (!otpFound) {
    const url = page.url();
    const errorText = await page.$eval('[class*="error"], [role="alert"], .alert', (el) =>
      (el as HTMLElement).innerText,
    ).catch(() => '');
    const detail = errorText ? ` Pesan: "${errorText.slice(0, 120)}"` : '';
    throw new Error(`Input OTP tidak muncul di halaman. URL: ${shortUrl(url)}${detail}`);
  }

  await sendStatus('📨 Kode OTP sudah dikirim ke email kamu!');
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

  // Single OTP field
  const singleSelectors = [
    'input[autocomplete="one-time-code"]',
    'input[name="code"]',
    'input[inputmode="numeric"][maxlength="6"]',
  ];
  let otpEntered = false;

  for (const sel of singleSelectors) {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      await humanClick(page, sel, 5000);
      await sleep(rand(200, 400));
      for (const ch of otp) {
        await page.keyboard.type(ch);
        await sleep(rand(80, 160));
      }
      logger.info({ userId, sel }, 'OTP typed in single field');
      otpEntered = true;
      break;
    }
  }

  if (!otpEntered) {
    // 6 individual digit boxes
    const digits = await page.$$('input[maxlength="1"]');
    if (digits.length > 0) {
      for (let i = 0; i < digits.length && i < otp.length; i++) {
        await digits[i].click();
        await sleep(rand(60, 120));
        await digits[i].type(otp[i]);
        await sleep(rand(80, 160));
      }
      logger.info({ userId, count: digits.length }, 'OTP typed in digit boxes');
      otpEntered = true;
    }
  }

  if (!otpEntered) {
    // Fallback: keyboard type
    await page.keyboard.type(otp, { delay: rand(80, 150) });
    logger.info({ userId }, 'OTP typed via keyboard fallback');
  }

  await sleep(rand(400, 800));

  // Submit (may auto-submit on last digit)
  await waitAndClick(page, [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Verify")',
    'button:has-text("Confirm")',
  ], 5000).catch(() => { /* may auto-submit */ });

  await sendStatus('🔄 OTP dikirim, menunggu redirect...');

  try {
    await page.waitForURL(/chatgpt\.com/, { timeout: 30000 });
  } catch {
    logger.warn({ userId, url: page.url() }, 'Timeout waiting for chatgpt.com after OTP');
  }

  await sleep(rand(2000, 4000));
  await sendStatus(`✅ Berada di: ${shortUrl(page.url())}`);

  // Handle new account setup (name/birthday)
  await handleNewAccountFlow(userId, page, sendStatus);

  // Go to chatgpt.com if not already there
  if (!page.url().startsWith('https://chatgpt.com')) {
    await sendStatus('🌐 Kembali ke chatgpt.com...');
    await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);
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
    await humanType(page, 'input[name="name"], input[id="name"]', randomName);
    await sendStatus(`📝 Akun baru: mengisi nama "${randomName}"`);
    await waitAndClick(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")'], 8000).catch(() => {});
    await sleep(2000);
  }

  const ageInput = await page.$('input[type="number"], input[name="age"]');
  if (ageInput && await ageInput.isVisible().catch(() => false)) {
    const age = generateRandomAge();
    await humanType(page, 'input[type="number"], input[name="age"]', age);
    await sendStatus(`📅 Mengisi umur: ${age}`);
    await waitAndClick(page, ['button[type="submit"]', 'button:has-text("Continue")'], 8000).catch(() => {});
    await sleep(2000);
  }

  const dateInput = await page.$('input[type="date"], input[name="birthdate"]');
  if (dateInput && await dateInput.isVisible().catch(() => false)) {
    const { month, day, year } = generateRandomBirthdate();
    await dateInput.fill(`${year}-${month}-${day}`);
    await sendStatus(`📅 Mengisi tanggal lahir: ${day}/${month}/${year}`);
    await waitAndClick(page, ['button[type="submit"]', 'button:has-text("Continue")'], 8000).catch(() => {});
    await sleep(2000);
  }

  const monthSel = await page.$('select[name="month"]');
  const daySel   = await page.$('select[name="day"]');
  const yearSel  = await page.$('select[name="year"]');
  if (monthSel && daySel && yearSel) {
    const { month, day, year } = generateRandomBirthdate();
    await monthSel.selectOption({ value: month });
    await daySel.selectOption({ value: day });
    await yearSel.selectOption({ value: year });
    await sendStatus(`📅 Mengisi tanggal lahir: ${day}/${month}/${year}`);
    await waitAndClick(page, ['button[type="submit"]', 'button:has-text("Continue")'], 8000).catch(() => {});
    await sleep(2000);
  }
}

// ─── Extract session token ────────────────────────────────────────────────────
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
  await sendStatus(`🔀 Menuju checkout: ${shortUrl(checkoutUrl)}`);
  await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(3000, 5000));
  await sendStatus(`✅ Berada di: ${shortUrl(page.url())}`);

  // Select GoPay
  await sendStatus('💳 Memilih metode pembayaran GoPay...');
  const gopayClicked = await waitAndClick(page, [
    'text=GoPay',
    'label:has-text("GoPay")',
    '[data-value*="gopay"]',
    'button:has-text("GoPay")',
    '[aria-label*="GoPay"]',
  ], 8000);

  if (gopayClicked) {
    await sendStatus('✅ GoPay dipilih');
  } else {
    await sendStatus('⚠️ GoPay tidak ditemukan, melanjutkan...');
  }

  await sleep(rand(1500, 2500));

  // Fill address if needed
  for (const sel of [
    'input[placeholder*="address" i]',
    'input[name="address"]',
    'input[placeholder*="alamat" i]',
  ]) {
    const el = await page.$(sel);
    if (el && await el.isVisible().catch(() => false)) {
      await humanType(page, sel, 'Jl. Sudirman No. 123, Jakarta Pusat');
      await sendStatus('📍 Alamat diisi otomatis');
      break;
    }
  }

  await sleep(rand(800, 1500));

  // Click Subscribe
  await sendStatus('🖱️ Menekan tombol Subscribe...');
  const subscribeClicked = await waitAndClick(page, [
    'button:has-text("Subscribe")',
    'button:has-text("Berlangganan")',
    'button[type="submit"]:has-text("Subscribe")',
    'button[type="submit"]',
  ], 10000);

  if (subscribeClicked) {
    await sendStatus('✅ Tombol Subscribe ditekan, menunggu redirect...');
  }

  await sleep(rand(5000, 7000));

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
