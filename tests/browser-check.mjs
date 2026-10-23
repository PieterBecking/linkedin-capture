import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
const root = process.cwd();
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(root, pathname);
    const body = await readFile(file);
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 410, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const fixture = await context.newPage();
  const example = 'Hey Pieter, I came across Servo7’s container-unloading robots. As you scale deployments, Robotic Crew can help with additional engineering talent in software, embedded systems, and QA. Could extra capacity be useful as the team grows?';
  function html(name, text, more = '') {
    return `<img class="global-nav__me-photo" alt="Pieter Becking"><main><div class="msg-thread"><h2 class="msg-entity-lockup__entity-title"><a class="msg-thread__link-to-profile" href="https://www.linkedin.com/in/test-person/">${name}</a></h2><ul class="msg-s-message-list-content"><li><span class="msg-s-message-group__name">${name}</span><time datetime="2026-10-22T19:14:00">7:14 PM</time><ul><li><p class="msg-s-event-listitem__body">${text}</p></li></ul></li>${more}</ul></div></main><div class="msg-overlay-conversation-bubble"><h2 class="msg-overlay-bubble-header__title">Wrong Person</h2><ul class="msg-s-message-list-content"><li><span class="msg-s-message-group__name">Wrong Person</span><p class="msg-s-event-listitem__body">I am a recruiter</p></li></ul></div>`;
  }
  await fixture.route('https://www.linkedin.com/**', route => route.fulfill({ contentType: 'text/html', body: html('Federica Maino', example) }));
  await fixture.goto('https://www.linkedin.com/messaging/thread/services/');
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', err => errors.push(err.message));
  let delayed = null;
  await panel.exposeFunction('__inject', async ({ files }) => {
    const snapshot = [];
    for (const file of files) snapshot[0] = { result: await fixture.evaluate(await readFile(path.join(root, file), 'utf8')) };
    if (delayed) { const wait = delayed; delayed = null; await wait; }
    return snapshot;
  });
  await panel.addInitScript(() => {
    const events = () => ({ callbacks: [], addListener(fn) { this.callbacks.push(fn); }, fire(...args) { this.callbacks.forEach(fn => fn(...args)); } });
    const data = {};
    const local = { async get(keys) { return data; }, async set(values) { Object.assign(data, values); } };
    window.mock = { tab: { id: 1, active: true, url: 'https://www.linkedin.com/messaging/thread/services/' }, data, optionsOpened: false };
    window.chrome = {
      tabs: { async query() { return [{ ...mock.tab }]; }, onActivated: events(), onUpdated: events() },
      scripting: { executeScript: args => window.__inject(args) },
      storage: { local, sync: { ...local, async remove() {} }, onChanged: events() },
      runtime: { openOptionsPage() { mock.optionsOpened = true; }, async sendMessage() { return { ok: true, data: { roles: [], stages: [] } }; } },
    };
    mock.navigate = url => { mock.tab.url = url; chrome.tabs.onUpdated.fire(1, { url }, mock.tab); };
  });
  await panel.goto(`${origin}/sidepanel.html`);
  await panel.waitForFunction(() => document.getElementById('replyKind').value === 'services');
  const initial = await panel.locator('#replyDraft').inputValue();
  assert.match(initial, /^Hey Federica,/);
  assert.match(initial, /external engineering support/);
  assert.equal(await panel.locator('#status').isVisible(), false);
  const reader = await fixture.evaluate('globalThis.LinkedInThreadReader.read()');
  assert.equal(reader.messages.length, 1, 'nested message nodes are deduplicated');
  assert.equal(reader.threadTitle, 'Federica Maino', 'floating overlay ignored');
  assert.equal(reader.viewerName, 'Pieter Becking');
  await fixture.evaluate(() => {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-convo-wrapper';
    const thread = document.querySelector('.msg-thread');
    thread.before(wrapper);
    wrapper.append(thread.querySelector('h2'), thread);
  });
  assert.equal(await fixture.evaluate(() => LinkedInThreadReader.read().threadTitle), 'Federica Maino', 'sibling thread headers are read');
  if (process.env.SCREENSHOT_PATH) await panel.screenshot({ path: process.env.SCREENSHOT_PATH });
  await panel.locator('#copyReplyBtn').click();
  assert.equal(await panel.evaluate(() => navigator.clipboard.readText()), initial);
  assert.match(await panel.locator('#replyStatus').textContent(), /Copied/);
  await panel.locator('#replyDraft').fill('Hi Federica, thanks! We are all set for now.');
  await panel.locator('#readReplyBtn').click();
  assert.equal(await panel.locator('#replyDraft').inputValue(), 'Hi Federica, thanks! We are all set for now.');
  await panel.locator('#captureBtn').click();
  await panel.waitForFunction(() => !document.getElementById('formCard').classList.contains('hidden'));
  assert.match(await panel.locator('#captureMeta').textContent(), /1 message captured from “Federica Maino”/);
  assert.match(await panel.locator('#preview').textContent(), /Robotic Crew/);

  async function navigate(id, name, text, more = '') {
    await fixture.evaluate(url => history.pushState({}, '', url), `/messaging/thread/${id}/`);
    await fixture.setContent(html(name, text, more));
    await panel.evaluate(url => mock.navigate(url), `https://www.linkedin.com/messaging/thread/${id}/`);
  }
  await navigate('investor', 'Alex Rivers', "I'm an investor at Example. We invest in robotics companies. Open to a chat?");
  await panel.waitForFunction(() => document.getElementById('replyKind').value === 'investor');
  assert.match(await panel.locator('#replyDraft').inputValue(), /^Hey Alex,/);
  assert.match(await panel.locator('#replyDraft').inputValue(), /customers and product/);
  assert.equal(await panel.locator('#formCard').isVisible(), false, 'CRM form must not show the old conversation');

  await navigate('services', 'Federica Maino', example);
  await panel.waitForFunction(() => document.getElementById('replyDraft').value.startsWith('Hi Federica'));
  assert.equal(await panel.locator('#replyDraft').inputValue(), 'Hi Federica, thanks! We are all set for now.');
  await panel.locator('#resetReplyBtn').click();
  assert.equal(await panel.locator('#replyDraft').inputValue(), initial);
  await panel.locator('#replyKind').selectOption('recruiter');
  assert.match(await panel.locator('#replyDraft').inputValue(), /external recruiters/);

  await navigate('customer', 'Casey Smith', 'Could we schedule another product deployment?');
  await panel.waitForFunction(() => document.getElementById('replyContext').textContent.includes('Casey'));
  assert.equal(await panel.locator('#replyKind').inputValue(), '');
  assert.equal(await panel.locator('#copyReplyBtn').isDisabled(), true);
  await panel.locator('#replyKind').selectOption('investor');
  assert.match(await panel.locator('#replyDraft').inputValue(), /^Hey Casey,/);
  await panel.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('blocked'); }; });
  await panel.locator('#copyReplyBtn').click();
  assert.match(await panel.locator('#replyStatus').textContent(), /press ⌘C or Ctrl\+C/);

  // Selecting a different conversation can keep the same inbox URL.
  await fixture.setContent(html('Same URL Person', 'I run a recruitment agency.'));
  await panel.locator('#readReplyBtn').click();
  await panel.waitForFunction(() => document.getElementById('replyContext').textContent.includes('Same URL Person'));
  assert.match(await panel.locator('#replyDraft').inputValue(), /^Hey Same,/);
  assert.match(await panel.locator('#replyDraft').inputValue(), /external recruiters/);

  const own = '<li class="msg-s-message-group--me"><span class="msg-s-message-group__name">Pieter Becking</span><p class="msg-s-event-listitem__body">Thanks, we are not hiring externally.</p></li>';
  await navigate('replied', 'Rae Smith', 'I am a recruiter', own);
  await panel.waitForFunction(() => document.getElementById('replyStatus').textContent.includes('You sent the latest'));
  assert.equal(await panel.locator('#copyReplyBtn').isDisabled(), true);

  // A changed URL can still be showing the old DOM. No stale draft is allowed.
  await fixture.evaluate(() => history.pushState({}, '', '/messaging/thread/loading/'));
  await panel.evaluate(() => mock.navigate('https://www.linkedin.com/messaging/thread/loading/'));
  await panel.waitForFunction(() => document.getElementById('replyStatus').textContent.includes('Waiting for'));
  assert.equal(await panel.locator('#copyReplyBtn').isDisabled(), true);
  await fixture.setContent(html('New Person', 'We run a recruitment agency.'));
  await panel.locator('#readReplyBtn').click();
  await panel.waitForFunction(() => document.getElementById('replyKind').value === 'recruiter');
  assert.match(await panel.locator('#replyDraft').inputValue(), /^Hey New,/);

  // An in-flight scrape is discarded after tab navigation.
  let resolveDelay;
  delayed = new Promise(r => { resolveDelay = r; });
  await panel.locator('#readReplyBtn').click();
  await panel.evaluate(() => mock.navigate('https://example.com/'));
  resolveDelay();
  await panel.waitForTimeout(100);
  assert.equal(await panel.locator('#replyCard').isVisible(), false);
  assert.equal(await panel.locator('#copyReplyBtn').isDisabled(), true);

  await panel.goto(`${origin}/options.html`);
  await panel.waitForFunction(() => document.getElementById('investorTemplate').value.length > 0);
  await panel.locator('#investorTemplate').fill('Hi {firstName}, happy to keep you posted!');
  await panel.locator('#saveRepliesBtn').click();
  assert.equal(await panel.evaluate(() => mock.data.replyTemplates.investor), 'Hi {firstName}, happy to keep you posted!');
  await panel.locator('#resetRepliesBtn').click();
  assert.match(await panel.locator('#investorTemplate').inputValue(), /customers and product/);
  await panel.locator('#investorTemplate').fill('');
  await panel.locator('#saveRepliesBtn').click();
  assert.match(await panel.locator('#repliesMsg').textContent(), /Fill in all three/);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: scoped DOM, duplicate messages, auto replies, clipboard, edits, CRM capture, navigation, stale reads, manual choices, already replied, settings.');
} finally {
  await browser.close();
  server.close();
}
