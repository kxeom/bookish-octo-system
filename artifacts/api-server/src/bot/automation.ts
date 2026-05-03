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

  // Submit — try button first, but OTP might auto-submit on 6th digit
  const submitted = await waitAndClick(page, [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Verify")',
    'button:has-text("Confirm")',
    'button:has-text("Submit")',
  ], 5000).catch(() => false);

  if (!submitted) {
    logger.info({ userId }, 'No submit button found — assuming OTP auto-submitted');
    // Press Enter as fallback
    await page.keyboard.press('Enter');
  }

  await sendStatus('🔄 OTP dikirim, menunggu redirect...');
  logger.info({ userId }, 'Waiting for redirect after OTP');

  // New accounts → auth.openai.com/about-you first, then chatgpt.com
  // Existing accounts → straight to chatgpt.com
  try {
    await page.waitForURL(
      (url) =>
        url.hostname.includes('chatgpt.com') ||
        (url.hostname.includes('auth.openai.com') && url.pathname !== '/email-verification'),
      { timeout: 45000 },
    );
  } catch {
    const currentUrl = page.url();
    logger.warn({ userId, url: currentUrl }, 'Timeout waiting for redirect after OTP');
    if (currentUrl.includes('auth.openai.com/email-verification')) {
      const pageText = await page.$eval('body', (b) => (b as HTMLElement).innerText).catch(() => '');
      if (/expired|invalid|incorrect|wrong/i.test(pageText)) {
        throw new Error('Kode OTP salah atau sudah kadaluarsa. Mulai ulang dengan /start');
      }
      // Try Enter once more
      await page.keyboard.press('Enter');
      await sleep(4000);
      try {
        await page.waitForURL(
          (url) => url.hostname.includes('chatgpt.com') || (url.hostname.includes('auth.openai.com') && url.pathname !== '/email-verification'),
          { timeout: 15000 },
        );
      } catch {
        throw new Error('Redirect setelah OTP gagal. Coba /start lagi.');
      }
    }
  }

  await sleep(rand(1500, 2500));
  const landedUrl = page.url();
  logger.info({ userId, url: landedUrl }, 'Landed after OTP');
  await sendStatus(`✅ Berada di: ${shortUrl(landedUrl)}`);

  // ── Handle auth.openai.com/about-you (new account setup) ─────────────────
  if (landedUrl.includes('auth.openai.com/about-you')) {
    await handleAboutYouPage(userId, page, sendStatus);
  }

  // ── Handle any remaining onboarding on chatgpt.com ────────────────────────
  await handleNewAccountFlow(userId, page, sendStatus);

  // Make sure we're on chatgpt.com home before extracting session
  const postOnboardingUrl = page.url();
  if (!postOnboardingUrl.startsWith('https://chatgpt.com')) {
    await sendStatus('🌐 Menuju chatgpt.com...');
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

// ─── Handle auth.openai.com/about-you ────────────────────────────────────────
// Page shows: "How old are you?" with Full name + Age inputs + "Finish creating account"
async function handleAboutYouPage(
  userId: number,
  page: Page,
  sendStatus: StatusCallback,
): Promise<void> {
  await sendStatus('📝 Mengisi data akun baru (nama & umur)...');
  logger.info({ userId }, 'Handling about-you page');

  await sleep(rand(1000, 2000));

  // ── Full name ─────────────────────────────────────────────────────────────
  const nameSelectors = [
    'input[placeholder="Full name"]',
    'input[placeholder*="name" i]',
    'input[name="name"]',
    'input[id="name"]',
    'input[autocomplete="name"]',
  ];
  for (const sel of nameSelectors) {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      const randomName = generateRandomName();
      await humanType(page, sel, randomName);
      await sendStatus(`📝 Nama: ${randomName}`);
      logger.info({ userId, randomName }, 'Full name filled on about-you');
      break;
    }
  }

  await sleep(rand(400, 800));

  // ── Age ───────────────────────────────────────────────────────────────────
  const ageSelectors = [
    'input[placeholder="Age"]',
    'input[placeholder*="age" i]',
    'input[name="age"]',
    'input[id="age"]',
    'input[type="number"]',
  ];
  for (const sel of ageSelectors) {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      const age = generateRandomAge();
      await humanType(page, sel, age);
      await sendStatus(`📅 Umur: ${age}`);
      logger.info({ userId, age }, 'Age filled on about-you');
      break;
    }
  }

  await sleep(rand(500, 1000));

  // ── Finish creating account ───────────────────────────────────────────────
  const finished = await waitAndClick(page, [
    'button:has-text("Finish creating account")',
    'button:has-text("Finish")',
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Done")',
  ], 10000);

  if (finished) {
    await sendStatus('✅ Akun berhasil dibuat, menunggu redirect...');
    logger.info({ userId }, 'Clicked finish on about-you');
  } else {
    logger.warn({ userId }, 'Could not find finish button on about-you');
  }

  // Wait for redirect to chatgpt.com after finishing account creation
  try {
    await page.waitForURL(
      (url) => url.hostname.includes('chatgpt.com'),
      { timeout: 20000 },
    );
    await sendStatus(`✅ Redirect ke: ${shortUrl(page.url())}`);
  } catch {
    logger.warn({ userId, url: page.url() }, 'Timeout waiting for chatgpt.com after about-you');
  }

  await sleep(rand(1500, 2500));
}

// ─── Handle new account onboarding (loops through all screens) ───────────────
// Handles /about-you, /onboarding, name/birthday/age inputs
async function handleNewAccountFlow(
  userId: number,
  page: Page,
  sendStatus: StatusCallback,
): Promise<void> {
  // Loop through onboarding steps — each iteration handles one screen
  for (let step = 0; step < 8; step++) {
    const url = page.url();

    // Stop if we've reached chatgpt.com main chat (not an onboarding page)
    const isOnboarding =
      url.includes('/about-you') ||
      url.includes('/onboarding') ||
      url.includes('/setup') ||
      url.includes('/welcome') ||
      url.includes('/get-started');

    const isHome =
      url === 'https://chatgpt.com/' ||
      url === 'https://chatgpt.com' ||
      url.includes('/c/') ||
      url.includes('/?') ;

    if (isHome && !isOnboarding) {
      logger.info({ userId, url }, 'Onboarding complete — on chatgpt.com home');
      break;
    }

    logger.info({ userId, url, step }, 'Handling onboarding step');

    // ── Name input ──────────────────────────────────────────────────────────
    const nameSelectors = [
      'input[name="name"]',
      'input[id="name"]',
      'input[placeholder*="name" i]',
      'input[placeholder*="nama" i]',
      'input[autocomplete="name"]',
      'input[autocomplete="given-name"]',
    ];
    for (const sel of nameSelectors) {
      const el = await page.$(sel).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        const randomName = generateRandomName();
        await humanType(page, sel, randomName);
        await sendStatus(`📝 Mengisi nama: ${randomName}`);
        logger.info({ userId, sel, randomName }, 'Name filled');
        break;
      }
    }

    // ── Birthday — date input ───────────────────────────────────────────────
    const dateInput = await page.$('input[type="date"], input[name="birthdate"], input[name="birthday"]').catch(() => null);
    if (dateInput && await dateInput.isVisible().catch(() => false)) {
      const { month, day, year } = generateRandomBirthdate();
      await dateInput.fill(`${year}-${month}-${day}`);
      await sendStatus(`📅 Mengisi tanggal lahir: ${day}/${month}/${year}`);
      logger.info({ userId }, 'Birthdate filled via date input');
    }

    // ── Birthday — separate selects ─────────────────────────────────────────
    const monthSel = await page.$('select[name="month"], select[id="month"]').catch(() => null);
    const daySel   = await page.$('select[name="day"],   select[id="day"]').catch(() => null);
    const yearSel  = await page.$('select[name="year"],  select[id="year"]').catch(() => null);
    if (monthSel && daySel && yearSel) {
      const { month, day, year } = generateRandomBirthdate();
      await monthSel.selectOption({ value: month });
      await sleep(300);
      await daySel.selectOption({ value: day });
      await sleep(300);
      await yearSel.selectOption({ value: year });
      await sendStatus(`📅 Mengisi tanggal lahir: ${day}/${month}/${year}`);
      logger.info({ userId }, 'Birthdate filled via selects');
    }

    // ── Age input ───────────────────────────────────────────────────────────
    const ageInput = await page.$('input[name="age"], input[id="age"], input[type="number"]').catch(() => null);
    if (ageInput && await ageInput.isVisible().catch(() => false)) {
      const age = generateRandomAge();
      await humanType(page, 'input[name="age"], input[id="age"], input[type="number"]', age);
      await sendStatus(`📅 Mengisi umur: ${age}`);
      logger.info({ userId, age }, 'Age filled');
    }

    // ── Click Continue/Next/Done to proceed to next screen ─────────────────
    await sleep(rand(500, 1000));
    const continued = await waitAndClick(page, [
      'button[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Done")',
      'button:has-text("Get started")',
      'button:has-text("Agree")',
      'button:has-text("Accept")',
      'button:has-text("I agree")',
      'button:has-text("OK")',
    ], 6000);

    if (continued) {
      logger.info({ userId, step }, 'Clicked continue on onboarding step');
      await sleep(rand(2000, 3500));
    } else {
      // No button found — might already be done or waiting
      logger.info({ userId, step }, 'No continue button found on step');
      await sleep(2000);
      // Check if URL changed
      if (page.url() === url) {
        // Same URL, nothing happened — stop looping
        logger.info({ userId }, 'URL unchanged, stopping onboarding loop');
        break;
      }
    }
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
  logger.info({ userId, checkoutUrl }, 'processCheckout: navigating to checkout URL');
  await sendStatus(`🔀 Menuju checkout: ${shortUrl(checkoutUrl)}`);

  await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait longer for Stripe.js to fully render (it's slow)
  await sleep(rand(5000, 7000));

  const pageAfterNav = page.url();
  logger.info({ userId, url: pageAfterNav }, 'processCheckout: landed on page');
  await sendStatus(`✅ Berada di: ${shortUrl(pageAfterNav)}`);

  // Dump visible text to help debug what's on the page
  const pageText = await page.$eval('body', (b) => (b as HTMLElement).innerText)
    .catch(() => '');
  logger.info({ userId, preview: pageText.slice(0, 300) }, 'processCheckout: page text preview');

  // ── Try to select GoPay ──────────────────────────────────────────────────
  await sendStatus('💳 Memilih metode pembayaran GoPay...');

  // Stripe checkout for Indonesia may render GoPay inside an iframe — check both
  const gopaySelectors = [
    'input[value*="gopay" i]',
    'input[value*="go_pay" i]',
    '[data-type*="gopay" i]',
    '[data-payment-method*="gopay" i]',
    'label:has-text("GoPay")',
    'button:has-text("GoPay")',
    '[aria-label*="GoPay" i]',
    'div:has-text("GoPay") input[type="radio"]',
    'li:has-text("GoPay")',
  ];

  let gopayClicked = false;

  // Try in main frame
  for (const sel of gopaySelectors) {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      await humanClick(page, sel, 5000);
      gopayClicked = true;
      logger.info({ userId, sel }, 'GoPay selected in main frame');
      break;
    }
  }

  // Try inside iframes if not found in main frame
  if (!gopayClicked) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      for (const sel of gopaySelectors) {
        const el = await frame.$(sel).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) {
          await el.click();
          gopayClicked = true;
          logger.info({ userId, sel, frameUrl: frame.url() }, 'GoPay selected in iframe');
          break;
        }
      }
      if (gopayClicked) break;
    }
  }

  if (gopayClicked) {
    await sendStatus('✅ GoPay dipilih');
    // Give Stripe iframe time to show name/phone fields after GoPay selection
    await sleep(rand(2000, 3000));
  } else {
    logger.warn({ userId }, 'GoPay not found on checkout page — returning raw checkout URL');
    await sendStatus('⚠️ GoPay tidak ditemukan di halaman checkout');
    return checkoutUrl;
  }

  // Wait for Stripe to render address/name fields after GoPay selection
  await sleep(rand(1500, 2500));

  // ── Fill ALL billing fields across all Stripe iframes ────────────────────
  // Stripe uses separate iframes: elements-inner-payment-* (GoPay selector)
  // and elements-inner-address-* (billing address with name, country, address, etc.)
  const allSearchFrames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];

  const randomName = generateRandomName();

  for (const frame of allSearchFrames) {
    const furl = frame.url();

    // ── Name ────────────────────────────────────────────────────────────────
    for (const sel of [
      'input[name="name"]',
      'input[autocomplete="name"]',
      'input[placeholder*="Full name" i]',
      'input[placeholder*="Name" i]',
    ]) {
      const el = await frame.$(sel).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        await el.click(); await sleep(rand(100, 200));
        await el.fill(randomName);
        await sendStatus(`📝 Nama: ${randomName}`);
        logger.info({ userId, sel, randomName, furl: furl.slice(0, 60) }, 'Name filled');
        break;
      }
    }

    // ── Country (select dropdown) ────────────────────────────────────────────
    for (const sel of [
      'select[name="country"]',
      'select[autocomplete="country"]',
      'select[autocomplete="country-name"]',
    ]) {
      const el = await frame.$(sel).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        await el.selectOption({ label: 'Indonesia' }).catch(() => el.selectOption({ value: 'ID' }));
        await sendStatus('🌏 Negara: Indonesia');
        logger.info({ userId, sel, furl: furl.slice(0, 60) }, 'Country set to Indonesia');
        // Wait longer for Stripe to re-render address fields after country change
        await sleep(rand(1500, 2000));
        break;
      }
    }

    // ── Address line 1 ───────────────────────────────────────────────────────
    // Stripe internal field name is "addressLine1" (camelCase), not "line1"
    for (const sel of [
      'input[name="addressLine1"]',
      'input[autocomplete="address-line1"]',
      'input[name="line1"]',
      'input[name="address"]',
      'input[placeholder*="Address" i]',
      'input[placeholder*="Street" i]',
    ]) {
      const el = await frame.$(sel).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        await el.click(); await sleep(rand(100, 200));
        await el.fill('Jl. Sudirman No. 1');
        await sendStatus('📍 Alamat: Jl. Sudirman No. 1');
        logger.info({ userId, sel, furl: furl.slice(0, 60) }, 'Address line 1 filled');
        break;
      }
    }

    // ── City (Stripe uses "locality") ─────────────────────────────────────────
    for (const sel of [
      'input[name="locality"]',
      'input[autocomplete="address-level2"]',
      'input[name="city"]',
      'input[placeholder*="City" i]',
      'input[placeholder*="Kota" i]',
    ]) {
      const el = await frame.$(sel).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        await el.click(); await sleep(rand(100, 200));
        await el.fill('Jakarta Pusat');
        await sendStatus('🏙️ Kota: Jakarta Pusat');
        logger.info({ userId, sel, furl: furl.slice(0, 60) }, 'City filled');
        break;
      }
    }

    // ── State / Province (Stripe uses "administrativeArea") ──────────────────
    for (const sel of [
      'select[name="administrativeArea"]',
      'input[name="administrativeArea"]',
      'select[autocomplete="address-level1"]',
      'input[autocomplete="address-level1"]',
      'select[name="state"]',
      'input[name="state"]',
    ]) {
      const el = await frame.$(sel).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        const tag = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tag === 'select') {
          // Try common Indonesian province labels
          await (el as import('playwright').ElementHandle<HTMLSelectElement>)
            .selectOption({ label: 'DKI Jakarta' })
            .catch(() => (el as import('playwright').ElementHandle<HTMLSelectElement>).selectOption({ label: 'Jakarta' }))
            .catch(() => (el as import('playwright').ElementHandle<HTMLSelectElement>).selectOption({ index: 1 }));
        } else {
          await el.click(); await sleep(rand(100, 200));
          await el.fill('DKI Jakarta');
        }
        await sendStatus('🗺️ Provinsi: DKI Jakarta');
        logger.info({ userId, sel, furl: furl.slice(0, 60) }, 'State/province filled');
        break;
      }
    }

    // ── Postal code (Stripe uses "postalCode") ───────────────────────────────
    for (const sel of [
      'input[name="postalCode"]',
      'input[autocomplete="postal-code"]',
      'input[name="postal_code"]',
      'input[name="zip"]',
      'input[placeholder*="ZIP" i]',
      'input[placeholder*="Postal" i]',
      'input[placeholder*="Kode Pos" i]',
    ]) {
      const el = await frame.$(sel).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        await el.click(); await sleep(rand(100, 200));
        await el.fill('10220');
        await sendStatus('📮 Kode Pos: 10220');
        logger.info({ userId, sel, furl: furl.slice(0, 60) }, 'Postal code filled');
        break;
      }
    }
  }

  await sleep(rand(800, 1500));

  // ── Click Subscribe in main frame ─────────────────────────────────────────
  await sendStatus('🖱️ Menekan tombol Subscribe...');
  const subscribeClicked = await waitAndClick(page, [
    'button:has-text("Subscribe")',
    'button:has-text("Start free trial")',
    'button:has-text("Berlangganan")',
    'button:has-text("Pay")',
    'button[type="submit"]',
  ], 12000);

  if (subscribeClicked) {
    await sendStatus('✅ Subscribe ditekan, menunggu redirect ke Midtrans...');
    logger.info({ userId }, 'Subscribe clicked, waiting for Midtrans redirect');
  }

  // ── Wait up to 60s for redirect to Midtrans / GoPay payment page ─────────
  let midtransUrl: string | null = null;
  const redirectDeadline = Date.now() + 60000;

  while (Date.now() < redirectDeadline) {
    const currentUrl = page.url();

    if (!currentUrl.includes('chatgpt.com') && currentUrl.startsWith('http')) {
      midtransUrl = currentUrl;
      logger.info({ userId, midtransUrl }, 'Landed on external payment page');
      break;
    }

    await sleep(2000);
  }

  const finalUrl = midtransUrl ?? page.url();
  logger.info({ userId, finalUrl, midtransUrl }, 'Final URL after subscribe');

  // ── Fallback diagnostics if no redirect ───────────────────────────────────
  if (!midtransUrl) {
    logger.warn({ userId, url: finalUrl }, 'No Midtrans redirect after 60s — dumping page state');

    // Dump visible text on the page to see error messages
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '(failed to get text)');
    logger.warn({ userId, pageText: pageText.slice(0, 1000) }, 'Page text at timeout');

    // Dump any error/alert elements
    for (const frame of page.frames()) {
      const errEls = await frame.$$eval(
        '[role="alert"], .error, [class*="error" i], [class*="alert" i]',
        (els) => els.map((e) => (e as HTMLElement).innerText?.trim()).filter(Boolean),
      ).catch(() => [] as string[]);
      if (errEls.length) {
        logger.warn({ userId, errors: errEls, frameUrl: frame.url().slice(0, 60) }, 'Error elements on page');
      }
    }

    // Dump all frames + their inputs at failure time
    for (const frame of page.frames()) {
      const inputs = await frame.$$eval('input, select, button[type="submit"]', (els) =>
        els.map((el) => ({
          tag: el.tagName,
          name: (el as HTMLInputElement).name,
          value: (el as HTMLInputElement).value?.slice(0, 40),
          placeholder: (el as HTMLInputElement).placeholder,
          visible: (el as HTMLElement).offsetParent !== null,
        })),
      ).catch(() => [] as object[]);
      if (inputs.length) {
        logger.warn({ userId, frameUrl: frame.url().slice(0, 80), inputs }, 'Frame fields at timeout');
      }
    }

    await sendStatus('⚠️ Tidak ada redirect ke Midtrans setelah 60 detik. Cek logs untuk detail.');
    return checkoutUrl;
  }

  await sendStatus(`✅ Berada di: ${shortUrl(finalUrl)}`);
  return finalUrl;
}

// ─── Close session — wipe all browser data then close ─────────────────────────
export async function closeSession(userId: number): Promise<void> {
  const s = sessions.get(userId);
  if (!s) return;

  try {
    // Clear all cookies, localStorage, sessionStorage, cache so next session is 100% fresh
    await s.context.clearCookies().catch(() => {});
    await s.context.clearPermissions().catch(() => {});

    // Clear storage for every page in the context
    for (const page of s.context.pages()) {
      await page.evaluate(() => {
        try { localStorage.clear(); } catch (_) {}
        try { sessionStorage.clear(); } catch (_) {}
        try { indexedDB && Object.keys(indexedDB).forEach(() => {}); } catch (_) {}
      }).catch(() => {});
    }
  } catch (_) { /* ignore cleanup errors */ }

  await s.browser.close().catch(() => {});
  sessions.delete(userId);
  logger.info({ userId }, 'Browser session closed and data wiped');
}
