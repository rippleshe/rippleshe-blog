import { chromium } from 'playwright-core';

const BASE = String(process.env.EDGEONE_SITE_URL || 'https://rippleshe.cyou').replace(/\/+$/, '');
const failures = [];

async function api(path, options) {
  const response = await fetch(`${BASE}${path}`, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

const health = await api('/api/guestbook/health');
if (!health.response.ok || health.data?.auth !== 'email-password') failures.push('guestbook health/auth failed');

const configResult = await api('/api/guestbook/config');
const config = configResult.data?.data || {};
if (!configResult.response.ok || configResult.data?.ok !== true || config.auth !== 'email-password') failures.push('guestbook config failed');

const messages = await api('/api/guestbook/messages');
if (!messages.response.ok || messages.data?.ok !== true) failures.push('public messages failed');
if (messages.data?.data?.messages?.some?.((message) => Object.hasOwn(message, 'email'))) failures.push('public messages expose email');

// ponytail: keep only side-effect-free trust-boundary probes in the release audit.
for (const path of ['/api/guestbook/auth/send', '/api/guestbook/auth/password']) {
  const result = await api(path, {
    method:'POST',
    headers:{ 'content-type':'application/json', origin:'https://not-rippleshe.invalid' },
    body:'{}',
  });
  if (result.response.status !== 403) failures.push(`cross-origin POST accepted: ${path}`);
}

let browser;
try {
  browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  const page = await browser.newPage({ viewport:{ width:1280, height:900 } });
  const cloudbaseRequests = [];
  const consoleErrors = [];
  page.on('request', (request) => { if (/api\.tcloudbasegateway\.com/i.test(request.url())) cloudbaseRequests.push(request.url()); });
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const guestResponse = await page.goto(`${BASE}/guestbook/`, { waitUntil:'networkidle' });
  const guest = await page.evaluate(() => ({
    provider:document.querySelector('#guestbook-app')?.getAttribute('data-provider') || '',
    registerDisabled:document.querySelector('#guestbook-register-open')?.disabled ?? null,
    loginDisabled:document.querySelector('#guestbook-login-open')?.disabled ?? null,
    hasPassword:Boolean(document.querySelector('#guestbook-app input[type="password"]')),
    hasCode:Boolean(document.querySelector('#guestbook-app input[name="code"]')),
  }));
  if (guestResponse?.status() !== 200 || guest.provider !== 'edgeone') failures.push('public guestbook page failed');
  if (guest.registerDisabled !== !Boolean(config.registration_open)) failures.push('registration UI does not match public gate');
  if (guest.loginDisabled !== false || !guest.hasPassword || !guest.hasCode) failures.push('guestbook auth controls are incomplete');

  const ownerResponse = await page.goto(`${BASE}/visitors/`, { waitUntil:'networkidle' });
  const owner = await page.evaluate(() => ({
    provider:document.querySelector('#visitors-app')?.getAttribute('data-provider') || '',
    email:Boolean(document.querySelector('#visitors-owner-email')),
    code:Boolean(document.querySelector('#visitors-owner-code')),
    key:Boolean(document.querySelector('#visitors-owner-key')),
    robots:document.querySelector('meta[name="robots"]')?.getAttribute('content') || '',
  }));
  if (ownerResponse?.status() !== 200 || owner.provider !== 'edgeone') failures.push('owner page failed');
  if (!owner.email || !owner.code || owner.key || !owner.robots.includes('noindex')) failures.push('owner page boundary failed');
  if (cloudbaseRequests.length) failures.push('browser connected directly to CloudBase');
  if (consoleErrors.length) failures.push(`browser console errors: ${consoleErrors.join(' | ')}`);
} finally {
  if (browser) await browser.close();
}

console.log(JSON.stringify({
  base:BASE,
  gates:{ registration:Boolean(config.registration_open), writing:Boolean(config.writing_open) },
  failures,
  ok:failures.length === 0,
}, null, 2));
if (failures.length) process.exit(1);
