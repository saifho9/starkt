import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType } from 'discord.js';
import { StaffStats } from '../models/staffStats.js';
import { SECTORS } from '../config/sectors.js';
import { getSectorRanges } from '../services/roleService.js';
import { requireId, AppError } from '../utils/errors.js';
import { createDashboardAuth } from './auth.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const route = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function createWebApp({ client, logger, ticketService, panelService, isReady = () => client.isReady(), password = process.env.DASHBOARD_PASSWORD || process.env.PANEL_PASSWORD, sessionSecret = process.env.DASHBOARD_SESSION_SECRET, statsModel = StaffStats }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" });
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => res.status(isReady() ? 200 : 503).json({ ok: isReady() }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const auth = createDashboardAuth({ password, secret: sessionSecret, logger });
  app.get('/api/auth/session', (req, res) => res.json({ authenticated: auth.validSession(req), ready: isReady() }));
  app.post('/api/auth/login', auth.sameOrigin, auth.login);
  app.post('/api/auth/logout', auth.sameOrigin, auth.logout);
  app.use('/api', auth.sameOrigin, auth.requireSession);
  app.get('/api/status', (_req, res) => res.json({ ready: isReady(), botName: client.user?.tag || '' }));
  app.use('/api', (_req, res, next) => isReady() ? next() : res.status(503).json({ message: 'البوت يتصل بديسكورد وقاعدة البيانات. أعد المحاولة بعد قليل.' }));
  app.param('guildId', (req, _res, next, value) => { try { requireId(value, 'السيرفر'); next(); } catch (e) { next(e); } });

  app.get('/api/guilds', route(async (_req, res) => res.json(client.guilds.cache.map(g => ({ id: g.id, name: g.name })))));
  app.get('/api/guilds/:guildId/resources', route(async (req, res) => {
    const guild = await client.guilds.fetch(req.params.guildId);
    const [channels, roles] = await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
    const sorted = [...channels.values()].filter(Boolean).sort((a, b) => (a.position || 0) - (b.position || 0));
    res.json({
      channels: sorted.filter(c => c.type === ChannelType.GuildText).map(c => ({ id: c.id, name: c.name })),
      categories: sorted.filter(c => c.type === ChannelType.GuildCategory).map(c => ({ id: c.id, name: c.name })),
      roles: [...roles.values()].filter(r => r.id !== guild.id).sort((a, b) => b.comparePositionTo(a)).map(r => ({ id: r.id, name: r.name, position: r.position }))
    });
  }));
  app.get('/api/guilds/:guildId/channels', route(async (req, res) => {
    const guild = await client.guilds.fetch(req.params.guildId);
    const channels = await guild.channels.fetch();
    res.json(channels.filter(c => c?.type === ChannelType.GuildText).map(c => ({ id: c.id, name: c.name })));
  }));

  app.get('/api/guilds/:guildId/panels', route(async (req, res) => res.json(await panelService.listPanels(req.params.guildId))));
  app.post('/api/guilds/:guildId/panels', route(async (req, res) => res.status(201).json(await panelService.savePanel(req.params.guildId, req.body))));
  app.get('/api/guilds/:guildId/panels/:panelId', route(async (req, res) => res.json(await panelService.getPanel(req.params.guildId, req.params.panelId))));
  app.put('/api/guilds/:guildId/panels/:panelId', route(async (req, res) => res.json(await panelService.savePanel(req.params.guildId, req.body, req.params.panelId))));
  app.post('/api/guilds/:guildId/panels/:panelId/publish', route(async (req, res) => res.json(await panelService.postPanel(req.params.guildId, req.params.panelId))));
  app.post('/api/guilds/:guildId/discover', route(async (req, res) => res.status(202).json(panelService.startDiscovery(req.params.guildId))));
  app.get('/api/guilds/:guildId/discover', route(async (req, res) => res.json(panelService.getDiscoveryStatus(req.params.guildId))));

  app.get('/api/guilds/:guildId/tickets', route(async (req, res) => res.json(await ticketService.listTickets(req.params.guildId))));
  app.patch('/api/guilds/:guildId/tickets/:channelId', route(async (req, res) => res.json(await ticketService.editTicket(req.params.guildId, req.params.channelId, req.body))));
  app.get('/api/guilds/:guildId/sectors', route(async (req, res) => {
    const guild = await client.guilds.fetch(req.params.guildId);
    const roles = await guild.roles.fetch();
    const ranges = getSectorRanges(roles);
    res.json(ranges.map(s => ({
      ...SECTORS.find(c => c.id === s.id), error: s.error,
      roles: s.error ? [] : [...roles.values()].filter(r => r.id !== guild.id && !r.managed && r.comparePositionTo(s.lower) >= 0 && r.comparePositionTo(s.upper) <= 0)
        .sort((a, b) => a.comparePositionTo(b)).map(r => ({ id: r.id, name: r.name, editable: r.editable,
          overlap: ranges.filter(other => !other.error && r.comparePositionTo(other.lower) >= 0 && r.comparePositionTo(other.upper) <= 0).length > 1 }))
    })));
  }));

  app.get('/api/guilds/:guildId/stats/top', route(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const docs = await statsModel.find({ guildId: req.params.guildId }).sort({ claimedCount: -1 }).limit(limit).lean();
    const guild = await client.guilds.fetch(req.params.guildId);
    res.json(await Promise.all(docs.map(async d => {
      const member = await guild.members.fetch(d.userId).catch(() => null);
      return { ...d, displayName: member?.displayName || d.userId };
    })));
  }));
  app.post('/api/guilds/:guildId/stats/reset', route(async (req, res) => {
    await client.guilds.fetch(req.params.guildId);
    const userId = req.body?.userId;
    if (userId) {
      requireId(userId, 'العضو');
      await statsModel.updateOne({ guildId: req.params.guildId, userId }, { $set: { claimedCount: 0 } }, { upsert: true });
    } else await statsModel.updateMany({ guildId: req.params.guildId }, { $set: { claimedCount: 0 } });
    res.json({ ok: true });
  }));
  // المسارات القديمة لا تختار أول لوحة عشوائيًا عند وجود أكثر من لوحة.
  async function legacyId(req) {
    const id = req.body?.panelId || req.query.panelId || req.body?._id;
    if (id) return id;
    const panels = await panelService.listPanels(req.params.guildId);
    if (panels.length > 1) throw new AppError('اختر اللوحة من قائمة جميع اللوحات قبل تعديلها أو نشرها.', 409);
    return panels[0]?._id?.toString();
  }
  app.get('/api/guilds/:guildId/panel', route(async (req, res) => { const id = await legacyId(req); res.json(id ? await panelService.getPanel(req.params.guildId, id) : null); }));
  app.post('/api/guilds/:guildId/panel', route(async (req, res) => res.json(await panelService.savePanel(req.params.guildId, req.body, await legacyId(req)))));
  app.post('/api/guilds/:guildId/panel/publish', route(async (req, res) => { const id = await legacyId(req); if (!id) throw new AppError('لا توجد لوحة محفوظة.'); res.json(await panelService.postPanel(req.params.guildId, id)); }));

  app.use('/api', (_req, res) => res.status(404).json({ message: 'المسار المطلوب غير موجود.' }));
  app.use(express.static(publicDir, { etag: true, maxAge: 0 }));
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use((error, _req, res, _next) => {
    const status = error instanceof AppError ? error.status : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    if (status >= 500) logger.error('خطأ في لوحة التحكم', { name: error.name, code: error.code, message: error.message });
    res.status(status).json({ message: status === 500 ? 'تعذر إتمام الطلب. راجع اتصال البوت وصلاحياته ثم حاول مرة أخرى.' : error.message });
  });
  return app;
}

export async function startWebServer(options) {
  const app = createWebApp(options);
  return new Promise((resolve, reject) => {
    const server = app.listen(options.port, options.host, () => {
      options.logger.info(`لوحة التحكم تعمل على ${options.baseUrl || `المنفذ ${server.address().port}`}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}
