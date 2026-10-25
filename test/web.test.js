import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebApp } from '../src/web/server.js';
import { makeDiscord, GUILD, PANEL_ID, SECOND_ID, logger } from './helpers.js';

test('dashboard HTTP routes, session protection and exact panel targeting', async t => {
  const d = makeDiscord(), calls = [];
  let ready = true;
  const docs = [{ _id: PANEL_ID, guildId: GUILD, name: 'الشرطة' }, { _id: SECOND_ID, guildId: GUILD, name: 'الميكانيكي' }];
  const panelService = {
    async listPanels() { return docs; }, async getPanel(g, id) { calls.push(['get', g, id]); return docs.find(p => p._id === id); },
    async savePanel(g, data, id) { calls.push(['save', g, data, id]); return { ...data, _id: id || PANEL_ID }; },
    async postPanel(g, id) { calls.push(['publish', g, id]); return { _id: id }; },
    startDiscovery() { return { state: 'running' }; }, getDiscoveryStatus() { return { state: 'complete' }; }
  };
  const ticketService = { async listTickets() { return []; }, async editTicket(g, id, data) { calls.push(['ticket', g, id, data]); return { ok: true }; } };
  const app = createWebApp({ client: d.client, panelService, ticketService, logger, password: 'test-password', isReady: () => ready });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, opts = {}) => fetch(`${base}${path}`, opts);
  let cookie;
  await t.test('API rejects anonymous requests and public shell is available', async () => { assert.equal((await request('/api/guilds')).status, 401); const page = await request('/'); assert.equal(page.status, 200); assert.match(await page.text(), /لوحات التذاكر/); });
  await t.test('health reflects readiness, independent from panel authentication', async () => { assert.equal((await request('/health')).status, 200); ready = false; assert.equal((await request('/health')).status, 503); ready = true; });
  await t.test('reject wrong password and accept correct login with HttpOnly cookie', async () => {
    assert.equal((await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) })).status, 401);
    const response = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
    assert.equal(response.status, 200); const setCookie = response.headers.get('set-cookie'); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/i); cookie = setCookie.split(';')[0];
  });
  const auth = (path, opts = {}) => request(path, { ...opts, headers: { Cookie: cookie, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers } });
  await t.test('tampered cookies and cross-origin writes rejected', async () => {
    assert.equal((await request('/api/guilds', { headers: { Cookie: `${cookie}tamper` } })).status, 401);
    assert.equal((await auth(`/api/guilds/${GUILD}/panels`, { method: 'POST', headers: { Origin: 'https://other.invalid' }, body: '{}' })).status, 403);
  });
  await t.test('lists every saved panel instead of a findOne result', async () => { const res = await auth(`/api/guilds/${GUILD}/panels`); assert.equal(res.status, 200); assert.equal((await res.json()).length, 2); });
  await t.test('update and publish carry the selected panel ID', async () => {
    assert.equal((await auth(`/api/guilds/${GUILD}/panels/${SECOND_ID}`, { method: 'PUT', body: JSON.stringify({ name: 'اسم جديد' }) })).status, 200);
    assert.equal(calls.at(-1)[3], SECOND_ID);
    assert.equal((await auth(`/api/guilds/${GUILD}/panels/${SECOND_ID}/publish`, { method: 'POST' })).status, 200);
    assert.deepEqual(calls.at(-1), ['publish', GUILD, SECOND_ID]);
  });
  await t.test('legacy endpoints reject ambiguous writes rather than selecting first panel', async () => { for (const path of ['/panel', '/panel/publish']) assert.equal((await auth(`/api/guilds/${GUILD}${path}`, { method: 'POST', body: '{}' })).status, 409); });
  await t.test('reject invalid guild ID and unknown API endpoint', async () => { assert.equal((await auth('/api/guilds/wrong/panels')).status, 400); assert.equal((await auth('/api/unknown')).status, 404); });
  await t.test('API waits for Discord and Mongo readiness', async () => { ready = false; assert.equal((await auth('/api/guilds')).status, 503); ready = true; });
  await t.test('CSP prevents inline scripts and embeds', async () => { const res = await request('/'); assert.match(res.headers.get('content-security-policy'), /script-src 'self'/); assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(res.headers.get('x-powered-by'), null); });
  await t.test('session endpoint reports authenticated state', async () => { assert.equal((await (await auth('/api/auth/session')).json()).authenticated, true); assert.equal((await (await request('/api/auth/session')).json()).authenticated, false); });
  await t.test('logout clears the browser session', async () => { const res = await auth('/api/auth/logout', { method: 'POST' }); assert.equal(res.status, 200); assert.match(res.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/); });
});

test('login rate limiting stops repeated password guessing', async t => {
  const d = makeDiscord(); const app = createWebApp({ client: d.client, logger, password: 'valid-password' });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  for (let i = 0; i < 11; i++) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    assert.equal(res.status, i < 10 ? 401 : 429);
  }
});
