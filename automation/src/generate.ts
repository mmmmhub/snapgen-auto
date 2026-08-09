/**
 * SnapGen Automation — V4 (مبسط، سريع، مع signed URL)
 * 
 * npx tsx src/generate.ts
 * 
 * Env vars: SNAPGEN_EMAIL, SNAPGEN_PASSWORD, SNAPGEN_BASE_URL,
 *            JOB_ID, VIDEO_PROMPT, SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { chromium, type BrowserContext } from 'playwright';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ──────── CONFIG ────────
const TIMEOUTS = { login: 30_000, page: 30_000, video: 300_000, captcha: 90_000 };

// ──────── SUPABASE ────────
let sb: SupabaseClient;
function getSB(): SupabaseClient {
  if (sb) return sb;
  sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  console.log('✅ Supabase ready');
  return sb;
}

async function updateJob(id: string, status: string, extra: Record<string, string> = {}) {
  try {
    const payload: Record<string, unknown> = { status, updated_at: new Date().toISOString(), ...extra };
    const { error } = await getSB().from('video_jobs').update(payload).eq('id', id);
    console.log(error ? `❌ Update failed: ${error.message}` : `✅ Job ${id} → ${status}`);
  } catch (e) { console.error('Update error:', e); }
}

// ──────── MAIN ────────
async function main() {
  const jobId = process.env.JOB_ID!;
  const prompt = process.env.VIDEO_PROMPT!;
  const email = process.env.SNAPGEN_EMAIL!;
  const password = process.env.SNAPGEN_PASSWORD!;
  const baseUrl = process.env.SNAPGEN_BASE_URL || 'https://snapgen.ai/?hard=true';

  console.log(`🎬 Starting: ${jobId}`);
  console.log(`📝 "${prompt.substring(0, 80)}..."`);

  await updateJob(jobId, 'processing');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  let context: BrowserContext | null = null;
  let videoUrl: string | null = null;

  try {
    context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0',
    });

    const page = await context.newPage();

    // ── LOGIN ──
    console.log('🔐 Logging in...');
    await page.goto('https://snapgen.ai/auth/login', { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.page });

    // Check if already logged in
    await page.waitForTimeout(2000);
    if (page.url().includes('/studio') || page.url().includes('/history')) {
      console.log('✅ Already logged in');
    } else {
      // Google OAuth: click Google button
      const googleBtn = page.locator('button:has-text("Google"), button:has-text("google")').first();
      if (await googleBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('🔑 Using Google OAuth...');
        await googleBtn.click();
        
        // Google OAuth page
        await page.waitForURL('**/accounts.google.com/**', { timeout: TIMEOUTS.login });
        console.log('→ Google OAuth page');

        // Fill email
        await page.waitForSelector('input[type="email"]', { timeout: 10000 });
        await page.fill('input[type="email"]', email);
        await page.click('#identifierNext, button:has-text("Next")');
        
        // Fill password
        await page.waitForSelector('input[type="password"]', { timeout: 15000 });
        await page.waitForTimeout(1000);
        await page.fill('input[type="password"]', password);
        await page.waitForTimeout(500);
        await page.click('#passwordNext, button:has-text("Next")');
        
        // Wait for redirect back to snapgen
        await page.waitForURL('**/snapgen.ai/**', { timeout: TIMEOUTS.login }).catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        // Email/password form
        await page.waitForSelector('input[type="email"]', { timeout: 10000 });
        await page.fill('input[type="email"]', email);
        await page.fill('input[type="password"]', password);
        await page.getByRole('button', { name: /continue/i }).click();
        await page.waitForURL('**/studio**', { timeout: TIMEOUTS.login }).catch(() => {});
        await page.waitForTimeout(3000);
      }
      console.log('✅ Login done');
    }

    // ── GENERATE PAGE ──
    console.log('📄 Opening generate page...');
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.page });
    await page.waitForTimeout(2000);

    // Fill prompt
    console.log('✏️ Filling prompt...');
    const textarea = page.locator('textarea').first();
    await textarea.waitFor({ state: 'visible', timeout: 10000 });
    await textarea.click();
    await textarea.fill(prompt);
    console.log('✅ Prompt filled');

    // Optional: set resolution to 1080p
    const res1080p = page.locator('button:has-text("1080p"), [role="menuitem"]:has-text("1080p")').first();
    if (await res1080p.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Click the current resolution button to open dropdown, then select 1080p
      const resBtn = page.locator('button:has-text("720p"), button:has-text("1080p")').first();
      await resBtn.click();
      await page.waitForTimeout(500);
      await page.locator('[role="menuitem"]:has-text("1080p"), button:has-text("1080p")').first().click();
      console.log('✅ Resolution set to 1080p');
    } else {
      console.log('⚠️ Could not set resolution');
    }

    // ── SUBMIT & HANDLE CAPTCHA ──
    console.log('🚀 Clicking generate...');
    const genBtn = page.locator('form button[type="submit"], button:has-text("Pro Studio") + button, button svg.lucide-arrow-up').first();
    await genBtn.click();
    console.log('✅ Generate clicked');

    // Wait for captcha
    await page.waitForTimeout(2000);

    // Check if captcha appeared
    const captchaFrame = page.frameLocator('iframe[src*="turnstile"], iframe[src*="cloudflare"]').first();
    if (await captchaFrame.locator('body').isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('🔐 Captcha detected — attempting to solve...');
      // Try to click the checkbox
      const checkbox = captchaFrame.locator('[type="checkbox"], .challenge, #checkbox');
      if (await checkbox.isVisible({ timeout: 5000 }).catch(() => false)) {
        await checkbox.click();
        console.log('✅ Captcha checkbox clicked');
        await page.waitForTimeout(5000);
      } else {
        console.log('⚠️ Could not solve captcha — waiting for user');
        await updateJob(jobId, 'error', { error_message: 'Captcha detected — need manual solve' });
        return;
      }
    } else {
      console.log('ℹ️ No captcha detected');
    }

    // ── WAIT FOR VIDEO ──
    console.log('⏳ Waiting for video to generate...');
    
    // Wait for the video to complete (max 5 minutes)
    let videoReady = false;
    const startTime = Date.now();

    while (Date.now() - startTime < TIMEOUTS.video) {
      await page.waitForTimeout(5000);

      // Check for video completion
      const downloadBtn = page.locator('button:has-text("Download"), button:has-text("Download Video"), a[download]').first();
      if (await downloadBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        videoReady = true;
        console.log('✅ Video generation complete!');
        break;
      }

      // Check for error
      const errorText = await page.locator('text=Error, text=Failed, text=error').first().isVisible().catch(() => false);
      if (errorText) {
        const errorMsg = await page.locator('p:has-text("error"), p:has-text("Error")').first().textContent().catch(() => 'Unknown error');
        console.log(`❌ Generation error: ${errorMsg}`);
        await updateJob(jobId, 'error', { error_message: errorMsg || 'Generation failed' });
        return;
      }

      // Log progress
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (elapsed % 30 === 0) console.log(`  ⏳ Waiting... ${elapsed}s`);
    }

    if (!videoReady) {
      console.log('⌛ Timeout waiting for video');
      await updateJob(jobId, 'error', { error_message: 'Video generation timeout' });
      return;
    }

    // ── EXTRACT VIDEO URL ──
    console.log('📥 Getting video URL...');

    // Method 1: Click Download and capture download event
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }).catch(() => null),
      page.locator('button:has-text("Download")').first().click(),
    ]);

    if (download) {
      videoUrl = download.url();
      console.log(`✅ Download URL: ${videoUrl.substring(0, 100)}...`);
    } else {
      // Method 2: Get from video element
      videoUrl = await page.locator('video source, video').first().getAttribute('src').catch(() => null);
      if (videoUrl) console.log(`✅ Video src: ${videoUrl.substring(0, 100)}...`);
    }

    if (!videoUrl) {
      // Method 3: Navigate to history and get from there
      console.log('📋 Trying history page...');
      await page.goto('https://snapgen.ai/history', { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.page });
      await page.waitForTimeout(3000);

      // Find first completed video card and get download link
      const downloadLinks = page.locator('button:has-text("Download")').first();
      if (await downloadLinks.isVisible({ timeout: 5000 }).catch(() => false)) {
        const [histDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 30000 }).catch(() => null),
          downloadLinks.click(),
        ]);
        if (histDownload) videoUrl = histDownload.url();
      }
    }

    if (!videoUrl) {
      console.log('❌ Could not get video URL');
      await updateJob(jobId, 'error', { error_message: 'Could not extract video URL' });
      return;
    }

    // ── SAVE ──
    await updateJob(jobId, 'completed', { video_url: videoUrl });
    console.log('🎉 DONE! Video URL saved to Supabase');

  } catch (e) {
    console.error('💥 Fatal error:', e);
    await updateJob(jobId, 'error', { error_message: String(e) });
  } finally {
    if (context) await context.close();
    await browser.close();
  }
}

main();
