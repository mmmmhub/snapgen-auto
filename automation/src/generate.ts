/**
 * SnapGen.ai Video Generation Automation
 * 
 * تشغيل: npx tsx src/generate.ts
 * 
 * يتوقع متغيرات البيئة:
 *   SNAPGEN_EMAIL, SNAPGEN_PASSWORD, SNAPGEN_BASE_URL
 *   VIDEO_PROMPT, VIDEO_MODEL, VIDEO_RATIO, VIDEO_QUALITY, VIDEO_DURATION
 *   JOB_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface JobConfig {
  jobId: string;
  prompt: string;
  model: string;
  ratio: string;
  quality: string;
  duration: string;
}

interface SupabaseEnv {
  url: string;
  serviceKey: string;
}

interface SnapGenEnv {
  email: string;
  password: string;
  baseUrl: string;
}

// ──────────────────────────────────────────────
// Constants & Config
// ──────────────────────────────────────────────

const SCREENSHOT_DIR = path.resolve('./screenshots');
const LOG_DIR = path.resolve('./logs');
const MAX_RETRIES = 2;
const VIDEO_WAIT_TIMEOUT = 300_000; // 5 minutes
const CAPTCHA_TIMEOUT = 120_000;    // 2 minutes

// ──────────────────────────────────────────────
// Logger
// ──────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', message: string) {
  const timestamp = new Date().toISOString();
  const prefix = { INFO: 'ℹ️', WARN: '⚠️', ERROR: '❌', SUCCESS: '✅' }[level];
  const line = `[${timestamp}] ${prefix} ${message}`;
  console.log(line);
  ensureDir(LOG_DIR);
  fs.appendFileSync(path.join(LOG_DIR, 'generate.log'), line + '\n');
}

// ──────────────────────────────────────────────
// Supabase Client
// ──────────────────────────────────────────────

let sb: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (sb) return sb;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    log('WARN', 'Supabase credentials not set — will not persist results');
    // Return a dummy that doesn't crash
    return {
      from: () => ({
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        insert: () => Promise.resolve({ error: null }),
      }),
    } as unknown as SupabaseClient;
  }

  sb = createClient(url, key);
  log('INFO', 'Supabase client initialized');
  return sb;
}

async function updateJobStatus(
  jobId: string,
  status: 'processing' | 'completed' | 'error',
  extra: { video_url?: string; error_message?: string } = {}
) {
  try {
    const update: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (extra.video_url !== undefined) update.video_url = extra.video_url;
    if (extra.error_message !== undefined) update.error_message = extra.error_message;

    const { error } = await getSupabase()
      .from('video_jobs')
      .update(update)
      .eq('id', jobId);

    if (error) {
      log('ERROR', `Failed to update job ${jobId}: ${error.message}`);
    } else {
      log('SUCCESS', `Job ${jobId} status → ${status}`);
    }
  } catch (e) {
    log('ERROR', `Supabase update exception: ${e}`);
  }
}

// ──────────────────────────────────────────────
// SnapGen Automation
// ──────────────────────────────────────────────

async function runAutomation(config: JobConfig, snapEnv: SnapGenEnv): Promise<string | null> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    ensureDir(SCREENSHOT_DIR);

    // ── Launch Browser ──────────────────────
    log('INFO', 'Launching Chromium (headless)...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
      ],
    });

    context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const page: Page = await context.newPage();

    // ── Step 0: Login ───────────────────────
    log('INFO', 'Navigating to SnapGen login page...');
    await page.goto('https://snapgen.ai/auth/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // Check if already logged in (redirected to studio)
    const currentUrl = page.url();
    if (currentUrl.includes('/studio') || currentUrl.includes('/history')) {
      log('SUCCESS', 'Already logged in (session cookie active)');
    } else {
      log('INFO', 'Filling login form...');

      // Wait for form
      await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
      
      // Fill email
      const emailInput = page.locator('input[type="email"]');
      await emailInput.fill(snapEnv.email);
      
      // Fill password
      const passwordInput = page.locator('input[type="password"]');
      await passwordInput.fill(snapEnv.password);

      // Click Continue
      const continueBtn = page.getByRole('button', { name: /continue/i });
      await continueBtn.click();

      // Wait for redirect
      await page.waitForURL('**/studio**', { timeout: 15_000 }).catch(() => {
        log('WARN', 'No redirect to studio, continuing...');
      });
      await page.waitForTimeout(3000);

      log('SUCCESS', 'Login completed');
    }

    // ── Step 1: Navigate to ?hard=true ──────
    log('INFO', `Navigating to: ${snapEnv.baseUrl}`);
    await page.goto(snapEnv.baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForTimeout(2000);

    // Screenshot after navigation
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '01-hard-page.png'),
      fullPage: true,
    });

    // ── Step 1.5: Close popups ──────────────
    log('INFO', 'Checking for popups...');
    
    // API Notice: "Close and don't show again"
    try {
      const closeApiBtn = page.getByText('Close and don\'t show again', { exact: true });
      if (await closeApiBtn.isVisible({ timeout: 3000 })) {
        await closeApiBtn.click();
        log('INFO', 'Closed API notice popup');
      }
    } catch { /* no popup */ }

    // Discord: "Don't show again"
    try {
      const discordBtn = page.getByText('Don\'t show again', { exact: true });
      if (await discordBtn.isVisible({ timeout: 3000 })) {
        await discordBtn.click();
        log('INFO', 'Closed Discord popup');
      }
    } catch { /* no popup */ }

    await page.waitForTimeout(1000);

    // ── Step 2: Write Prompt ────────────────
    log('INFO', `Writing prompt: ${config.prompt.substring(0, 80)}...`);
    
    const promptTextarea = page.locator('form textarea').first();
    await promptTextarea.waitFor({ state: 'visible', timeout: 10_000 });
    await promptTextarea.click();
    await promptTextarea.clear();
    await promptTextarea.fill(config.prompt);
    await page.waitForTimeout(500);

    log('SUCCESS', 'Prompt written');

    // ── Step 3: Select Model ────────────────
    if (config.model !== 'veo') {
      log('INFO', `Selecting model: ${config.model}`);
      const modelMap: Record<string, string> = {
        veo: 'Veo 3.1 Fast',
        grok: 'Grok',
        bytedance: 'ByteDance',
        kling: 'Kling',
      };
      const modelName = modelMap[config.model] || 'Veo 3.1 Fast';
      try {
        await page.locator('button').filter({ hasText: modelName }).first().click();
        log('SUCCESS', `Model set to: ${modelName}`);
      } catch {
        log('WARN', `Could not select model: ${modelName}, using default`);
      }
    }

    // ── Step 4: Select Aspect Ratio ─────────
    if (config.ratio !== '16:9') {
      log('INFO', `Selecting ratio: ${config.ratio}`);
      try {
        await page.locator('button').filter({ hasText: config.ratio }).first().click();
        log('SUCCESS', `Ratio set to: ${config.ratio}`);
      } catch {
        log('WARN', `Could not select ratio: ${config.ratio}, using default`);
      }
    }

    // ── Step 5: Select Quality ──────────────
    if (config.quality !== '720p') {
      log('INFO', `Selecting quality: ${config.quality}`);
      try {
        // First we need to find and click the quality selector
        const qualityBtn = page.locator('button').filter({ hasText: config.quality });
        if (await qualityBtn.count() > 0) {
          await qualityBtn.first().click();
          log('SUCCESS', `Quality set to: ${config.quality}`);
        }
      } catch {
        log('WARN', `Could not select quality: ${config.quality}, using default`);
      }
    }

    // ── Step 6: Select Duration ─────────────
    if (config.duration !== '8') {
      log('INFO', `Selecting duration: ${config.duration}s`);
      try {
        const durBtn = page.locator('button').filter({ hasText: `${config.duration}s` });
        if (await durBtn.count() > 0) {
          await durBtn.first().click();
          log('SUCCESS', `Duration set to: ${config.duration}s`);
        }
      } catch {
        log('WARN', `Could not select duration: ${config.duration}s, using default`);
      }
    }

    // Screenshot before generating
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '02-before-generate.png'),
      fullPage: true,
    });

    // ── Step 7: Click Generate ──────────────
    log('INFO', 'Clicking Generate button...');

    // The generate button is the last button in the form (arrow icon, no text)
    const generateBtn = page.locator('form button').last();
    await generateBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await generateBtn.click();

    log('INFO', 'Generate clicked — waiting for captcha or processing...');

    // ── Step 8: Handle Captcha ──────────────
    // Check for Cloudflare Turnstile
    try {
      const captchaFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
      const captchaCheckbox = captchaFrame.locator('#checkbox');
      
      if (await captchaCheckbox.isVisible({ timeout: 5000 })) {
        log('WARN', 'Cloudflare Turnstile detected!');
        log('INFO', 'Turnstile requires manual solving in GitHub Actions.');
        log('INFO', 'This job will fail. Consider using a captcha solving service.');
        
        // Take screenshot for debugging
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, '03-captcha-detected.png'),
          fullPage: true,
        });

        // Update status to error with clear message
        await updateJobStatus(config.jobId, 'error', {
          error_message: 'Cloudflare Turnstile captcha detected — manual intervention required. Consider adding a captcha solving service (e.g., 2captcha, Anti-Captcha) to bypass this.',
        });

        return null;
      }
    } catch {
      // No captcha detected — continue
      log('INFO', 'No captcha detected, proceeding...');
    }

    // ── Step 9: Wait for Video ──────────────
    log('INFO', `Waiting for video generation (timeout: ${VIDEO_WAIT_TIMEOUT / 1000}s)...`);

    // Wait for either:
    // - A video element to appear
    // - A redirect to history with our video
    // - An error message

    let videoUrl: string | null = null;

    try {
      // Approach 1: Wait for <video> element on page
      const videoElement = await page.waitForSelector('video[src]', {
        timeout: VIDEO_WAIT_TIMEOUT,
      });

      videoUrl = await videoElement.getAttribute('src');
      log('SUCCESS', `Video element found with src: ${videoUrl}`);
    } catch {
      // Approach 2: Video might appear in history
      log('INFO', 'No video on current page, checking history...');
      
      // Navigate to history
      await page.goto('https://snapgen.ai/history', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.waitForTimeout(5000);

      // Click the first completed video card
      try {
        const firstCard = page.locator('img').first();
        await firstCard.click({ timeout: 5000 });
        await page.waitForTimeout(3000);
      } catch {
        log('WARN', 'Could not open video card');
      }

      // Try getting video from modal
      try {
        const modalVideo = page.locator('div[role="dialog"] video, [data-slot="dialog-content"] video');
        videoUrl = await modalVideo.getAttribute('src');
        if (videoUrl) {
          log('SUCCESS', `Video URL from modal: ${videoUrl}`);
        }
      } catch {
        log('ERROR', 'Could not find video URL anywhere');
      }
    }

    // Screenshot of result
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '04-result.png'),
      fullPage: true,
    });

    // ── Step 10: Extract video URL from page if not found ──
    if (!videoUrl) {
      // Last resort: extract URL from page content
      const pageContent = await page.content();
      
      // Look for R2 URLs, blob URLs, or mp4 links
      const urlPatterns = [
        /https:\/\/pub-[a-f0-9]+\.r2\.dev\/[^"'\s]+\.mp4/gi,
        /https:\/\/[^"'\s]*snapgen[^"'\s]*\.mp4/gi,
        /https:\/\/[^"'\s]*geminigen[^"'\s]*\.mp4/gi,
        /blob:https:\/\/snapgen\.ai\/[^"'\s]+/gi,
      ];

      for (const pattern of urlPatterns) {
        const matches = pageContent.match(pattern);
        if (matches && matches.length > 0) {
          videoUrl = matches[0];
          log('SUCCESS', `Video URL extracted from page: ${videoUrl}`);
          break;
        }
      }
    }

    // ── Step 11: Download Video ─────────────
    if (videoUrl && videoUrl.startsWith('http')) {
      log('INFO', `Video URL found: ${videoUrl}`);
      
      // Try clicking Download button as well
      try {
        const downloadBtn = page.locator('button').filter({ hasText: /download/i }).first();
        if (await downloadBtn.isVisible({ timeout: 3000 })) {
          await downloadBtn.click();
          log('INFO', 'Download button clicked');
          await page.waitForTimeout(3000);
        }
      } catch {
        log('INFO', 'No direct download button found');
      }
    } else if (!videoUrl) {
      log('ERROR', 'No video URL found at all');
    }

    return videoUrl;

  } catch (error) {
    log('ERROR', `Automation error: ${error}`);
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    
    log('INFO', 'Browser closed');
  }
}

// ──────────────────────────────────────────────
// Main Entry Point
// ──────────────────────────────────────────────

async function main() {
  log('INFO', '═══════════════════════════════════════');
  log('INFO', 'SnapGen Automation Starting');
  log('INFO', '═══════════════════════════════════════');

  // Parse config
  const config: JobConfig = {
    jobId: process.env.JOB_ID || `local-${Date.now()}`,
    prompt: process.env.VIDEO_PROMPT || 'A beautiful sunset over the ocean, cinematic 4k',
    model: process.env.VIDEO_MODEL || 'veo',
    ratio: process.env.VIDEO_RATIO || '16:9',
    quality: process.env.VIDEO_QUALITY || '1080p',
    duration: process.env.VIDEO_DURATION || '8',
  };

  const snapEnv: SnapGenEnv = {
    email: process.env.SNAPGEN_EMAIL || '',
    password: process.env.SNAPGEN_PASSWORD || '',
    baseUrl: process.env.SNAPGEN_BASE_URL || 'https://snapgen.ai/?hard=true',
  };

  // Validate
  if (!snapEnv.email || !snapEnv.password) {
    log('ERROR', 'Missing SNAPGEN_EMAIL or SNAPGEN_PASSWORD in environment');
    await updateJobStatus(config.jobId, 'error', {
      error_message: 'Missing credentials in environment variables',
    });
    process.exit(1);
  }

  log('INFO', `Job ID: ${config.jobId}`);
  log('INFO', `Prompt: ${config.prompt.substring(0, 100)}...`);
  log('INFO', `Model: ${config.model} | Ratio: ${config.ratio} | Quality: ${config.quality} | Duration: ${config.duration}s`);

  // Update status → processing
  await updateJobStatus(config.jobId, 'processing');

  let finalUrl: string | null = null;

  // Retry logic
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    log('INFO', `Attempt ${attempt}/${MAX_RETRIES + 1}`);
    
    try {
      finalUrl = await runAutomation(config, snapEnv);
      
      if (finalUrl) {
        log('SUCCESS', `Video generated successfully!`);
        log('SUCCESS', `URL: ${finalUrl}`);
        break;
      }
      
      if (attempt <= MAX_RETRIES) {
        log('WARN', `Retrying in 10 seconds...`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    } catch (error) {
      log('ERROR', `Attempt ${attempt} failed: ${error}`);
      if (attempt > MAX_RETRIES) throw error;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  // Final status update
  if (finalUrl && finalUrl.startsWith('http')) {
    await updateJobStatus(config.jobId, 'completed', { video_url: finalUrl });
    log('SUCCESS', '═══════════════════════════════════════');
    log('SUCCESS', 'DONE! Video URL saved to Supabase');
    log('SUCCESS', '═══════════════════════════════════════');
    process.exit(0);
  } else {
    await updateJobStatus(config.jobId, 'error', {
      error_message: 'Failed to extract video URL after all attempts',
    });
    log('ERROR', 'Exiting with error');
    process.exit(1);
  }
}

main().catch(async (err) => {
  log('ERROR', `Fatal: ${err.message || err}`);
  process.exit(1);
});
