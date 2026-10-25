import { ActionRowBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits, StringSelectMenuBuilder } from 'discord.js';
import { TicketPanel } from '../models/ticketPanel.js';
import { PanelMessage } from '../models/panelMessage.js';
import { AppError, objectId, requirePanelId } from '../utils/errors.js';
import { createSerialQueue } from '../utils/locks.js';
import { normalizePanel, parseTicketTopic, plain, snapshot, getOptionRoute } from './ticketConfig.js';
import { checkTextChannel, fetchMessageIfExists, getOpeningMessage, isText, selectedLabelFromMessage, visibleStaffRoleIds } from './discordHelpers.js';

export function panelMenu(message) {
  return message.components?.flatMap(r => r.components || []).find(c => c.type === 3 && /^ticket-panel:[a-f\d]{24}$/i.test(c.customId || ''));
}
export function messageAppearance(message) {
  const menu = panelMenu(message);
  const embed = message.embeds?.[0];
  if (!menu || !embed) throw new AppError('رسالة اللوحة لا تحتوي على قائمة وعنوان صالحين.');
  return {
    channelId: message.channelId,
    name: embed.title || 'لوحة مسترجعة',
    embedTitle: embed.title || 'التذاكر', embedDescription: embed.description || 'اختر نوع التذكرة',
    embedColor: embed.color ?? 0x5865f2, embedImageUrl: embed.image?.url || '',
    panelContent: message.content || '', selectPlaceholder: menu.placeholder || '',
    menuOptions: menu.options.map(o => ({ label: o.label, value: o.value, description: o.description || '' }))
  };
}
export function sameAppearance(panel, message) {
  const current = messageAppearance(message);
  return panel.channelId === current.channelId && panel.embedTitle === current.embedTitle
    && panel.embedDescription === current.embedDescription
    && JSON.stringify((panel.menuOptions || []).map(o => [o.value, o.label])) === JSON.stringify(current.menuOptions.map(o => [o.value, o.label]));
}

export function createPanelService({ client, logger, models = { TicketPanel, PanelMessage } }) {
  const Panel = models.TicketPanel;
  const Binding = models.PanelMessage;
  const serialize = createSerialQueue();
  const scans = new Map();

  async function getPanel(guildId, id) {
    requirePanelId(id);
    const doc = await Panel.findOne({ _id: id, guildId });
    if (!doc) throw new AppError('اللوحة غير موجودة في هذا السيرفر.', 404);
    return doc;
  }
  async function listPanels(guildId) {
    return Panel.find({ guildId }).sort({ createdAt: 1, _id: 1 }).lean();
  }
  async function validateResources(guildId, config) {
    const guild = await client.guilds.fetch(guildId);
    await checkTextChannel(guild, config.channelId, 'قناة اللوحة');
    const categories = new Set([config.ticketCategoryId, ...config.menuOptions.map(o => o.ticketCategoryId)].filter(Boolean));
    for (const id of categories) {
      const channel = await guild.channels.fetch(id).catch(e => { if (e.code === 10003) return null; throw e; });
      if (channel?.type !== ChannelType.GuildCategory) throw new AppError(`تصنيف التذاكر ${id} غير موجود. اختر التصنيف الصحيح.`);
    }
    const roles = await guild.roles.fetch();
    for (const id of [...config.staffRoleIds, ...config.menuOptions.flatMap(o => o.staffRoleIds || [])]) {
      if (id === guildId || !roles.has(id)) throw new AppError(`رتبة الطاقم ${id} غير موجودة أو هي رتبة الجميع.`);
    }
    for (const id of [config.claimLogChannelId, config.closeLogChannelId].filter(Boolean)) await checkTextChannel(guild, id, 'قناة السجل');
  }
  async function savePanel(guildId, data, id = null) {
    if (id) requirePanelId(id);
    return serialize(`save:${guildId}:${id || 'new'}`, async () => {
      const current = id ? await getPanel(guildId, id) : null;
      const normalized = normalizePanel(data, plain(current) || {});
      await validateResources(guildId, normalized);
      if (!current) return Panel.create({ ...normalized, guildId });
      const filter = { _id: id, guildId };
      if (data.expectedUpdatedAt) {
        const expected = new Date(data.expectedUpdatedAt);
        if (!Number.isFinite(expected.getTime())) throw new AppError('نسخة الإعدادات غير صالحة. أعد تحميل اللوحة.');
        filter.updatedAt = expected;
      }
      const update = { ...normalized };
      if (data.confirmRecovery === true) { update.needsReview = false; update.recoveryNote = 'تمت مراجعة الوجهة من لوحة التحكم.'; }
      const saved = await Panel.findOneAndUpdate(filter, { $set: update }, { new: true, runValidators: true });
      if (!saved) throw new AppError('تم تعديل اللوحة في جلسة أخرى. أعد تحميلها قبل الحفظ.', 409);
      return saved;
    });
  }

  function buildMessage(panel) {
    if (panel.needsReview) throw new AppError('راجع تصنيفات اللوحة المسترجعة واعتمدها قبل النشر.');
    const embed = new EmbedBuilder().setTitle(panel.embedTitle).setDescription(panel.embedDescription).setColor(panel.embedColor ?? 0x5865f2);
    if (panel.embedImageUrl) embed.setImage(panel.embedImageUrl);
    const menu = new StringSelectMenuBuilder().setCustomId(`ticket-panel:${panel._id}`)
      .setPlaceholder(panel.selectPlaceholder || 'اختر نوع التذكرة').setMinValues(1).setMaxValues(1)
      .addOptions(panel.menuOptions.map(o => ({ label: o.label, value: o.value, ...(o.description ? { description: o.description } : {}) })));
    return { content: panel.panelContent || '', embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)], allowedMentions: { parse: [] } };
  }
  async function bindMessage(guildId, panel, message) {
    return Binding.findOneAndUpdate({ guildId, messageId: message.id }, {
      $set: { channelId: message.channelId, panelId: panel._id, settings: snapshot(panel) }
    }, { upsert: true, new: true, setDefaultsOnInsert: true });
  }
  async function postPanel(guildId, id) {
    requirePanelId(id);
    return serialize(`publish:${guildId}:${id}`, async () => {
      const panel = await getPanel(guildId, id);
      await validateResources(guildId, plain(panel));
      const guild = await client.guilds.fetch(guildId);
      const channel = await checkTextChannel(guild, panel.channelId, 'قناة اللوحة');
      const me = await guild.members.fetchMe();
      if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory])) throw new AppError('البوت يحتاج عرض القناة وإرسال الرسائل والروابط المضمّنة وقراءة السجل في قناة اللوحة.');
      let message = await fetchMessageIfExists(channel, panel.messageId);
      if (message && message.author.id !== client.user.id) throw new AppError('رسالة اللوحة الحالية ليست مملوكة لهذا البوت.');
      message = message ? await message.edit(buildMessage(panel)) : await channel.send(buildMessage(panel));
      // حفظ رقم الرسالة لا يستبدل إعدادات معدّلة بالتزامن مع النشر.
      await Panel.updateOne({ _id: id, guildId }, { $set: { messageId: message.id } });
      await bindMessage(guildId, panel, message);
      return getPanel(guildId, id);
    });
  }

  async function collectEvidence(guild, legacyId) {
    const evidence = new Map();
    for (const channel of guild.channels.cache.values()) {
      const meta = parseTicketTopic(channel.topic);
      if (!isText(channel) || meta?.panelId !== legacyId) continue;
      try {
        const opening = await getOpeningMessage(channel, client.user.id);
        const label = selectedLabelFromMessage(opening);
        if (!label) continue;
        const route = { ticketCategoryId: channel.parentId || '', staffRoleIds: visibleStaffRoleIds(channel), ticketMessage: opening.embeds?.[0]?.description || '' };
        const key = JSON.stringify([route.ticketCategoryId, route.staffRoleIds]);
        const matches = evidence.get(label) || new Map();
        matches.set(key, route);
        evidence.set(label, matches);
      } catch (error) { logger.error('تعذر فحص تذكرة قديمة', { channelId: channel.id, code: error.code }); }
    }
    return evidence;
  }
  async function resolveMessage(message, guild, { evidence } = {}) {
    if (message.author?.id !== client.user.id || message.guildId !== guild.id) throw new AppError('رسالة اللوحة غير صالحة لهذا البوت أو السيرفر.');
    const menu = panelMenu(message);
    if (!menu) throw new AppError('رسالة لوحة التذاكر غير صالحة.');
    return serialize(`recover:${guild.id}:${message.id}`, async () => {
      const bound = await Binding.findOne({ guildId: guild.id, messageId: message.id });
      if (bound) {
        if (bound.channelId !== message.channelId) throw new AppError('قناة رسالة اللوحة لا تطابق الربط المحفوظ.');
        return { ...bound.settings, _id: String(bound.panelId) };
      }
      const legacyId = menu.customId.slice('ticket-panel:'.length);
      const original = objectId.test(legacyId) ? await Panel.findOne({ _id: legacyId, guildId: guild.id }) : null;
      if (original?.messageId === message.id && original.channelId === message.channelId) {
        await bindMessage(guild.id, original, message);
        return snapshot(original);
      }
      // إعادة المحاولة بعد انقطاع الحفظ لا تنشئ لوحة ثانية لنفس الرسالة.
      let recovered = await Panel.findOne({ guildId: guild.id, recoveredFromMessageId: message.id });
      if (!recovered) {
        const appearance = messageAppearance(message);
        const source = plain(original) || {};
        const safeCopy = original && sameAppearance(source, message);
        const routes = evidence || await collectEvidence(guild, legacyId);
        let needsReview = false;
        let ticketMessage = '';
        const options = appearance.menuOptions.map(o => {
          const found = routes.get(o.label);
          if (found?.size === 1) {
            const route = [...found.values()][0];
            ticketMessage ||= route.ticketMessage;
            return { ...o, ticketCategoryId: route.ticketCategoryId, staffRoleIds: route.staffRoleIds };
          }
          if (!found?.size && safeCopy) {
            const route = getOptionRoute(source, o.value);
            return { ...o, ticketCategoryId: route.categoryId || '', staffRoleIds: route.staffRoleIds };
          }
          needsReview = true;
          return o;
        });
        const data = {
          ...appearance, guildId: guild.id, messageId: message.id,
          recoveredFromMessageId: message.id, legacyPanelId: legacyId,
          ticketMessage: ticketMessage || (safeCopy ? source.ticketMessage : '') || '',
          staffRoleIds: [], menuOptions: options, needsReview,
          recoveryNote: needsReview ? 'إعداد الوجهة القديم لم يعد محفوظًا أو توجد تذاكر بوجهات متعارضة. اختر التصنيف والطاقم الصحيحين واعتمد المراجعة.' : 'تم استرجاع اللوحة من رسالتها وإعدادات التذاكر المتاحة.'
        };
        if (safeCopy) {
          data.claimLogChannelId = source.claimLogChannelId;
          data.closeLogChannelId = source.closeLogChannelId;
        }
        try { recovered = await Panel.create(data); }
        catch (error) {
          if (error.code !== 11000) throw error;
          recovered = await Panel.findOne({ guildId: guild.id, recoveredFromMessageId: message.id });
        }
        logger.info('تم استرجاع لوحة قديمة', { guildId: guild.id, messageId: message.id, needsReview });
      }
      await bindMessage(guild.id, recovered, message);
      return snapshot(recovered);
    });
  }

  function getDiscoveryStatus(guildId) {
    return scans.get(guildId) || { state: 'idle', channels: 0, messages: 0, recovered: 0, skipped: 0, errors: 0 };
  }
  function startDiscovery(guildId) {
    if (getDiscoveryStatus(guildId).state === 'running') return getDiscoveryStatus(guildId);
    const status = { state: 'running', channels: 0, messages: 0, recovered: 0, skipped: 0, errors: 0, startedAt: new Date().toISOString() };
    scans.set(guildId, status);
    (async () => {
      const guild = await client.guilds.fetch(guildId);
      await guild.channels.fetch();
      const me = await guild.members.fetchMe();
      // الرسائل المعروفة أولًا، ثم التاريخ كله؛ لا حذف ولا تعديل لرسائل ديسكورد.
      const known = await listPanels(guildId);
      for (const panel of known) {
        if (!panel.messageId) continue;
        try {
          const channel = await guild.channels.fetch(panel.channelId);
          if (!isText(channel)) continue;
          const message = await fetchMessageIfExists(channel, panel.messageId);
          if (message && panelMenu(message)) await resolveMessage(message, guild);
        } catch { status.errors++; }
      }
      const evidenceCache = new Map();
      for (const channel of guild.channels.cache.values()) {
        if (!isText(channel) || parseTicketTopic(channel.topic)) continue;
        if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) { status.skipped++; continue; }
        let before;
        try {
          while (true) {
            const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
            if (!messages.size) break;
            status.messages += messages.size;
            for (const message of messages.values()) {
              const menu = message.author?.id === client.user.id && panelMenu(message);
              if (!menu) continue;
              const legacyId = menu.customId.slice('ticket-panel:'.length);
              if (!evidenceCache.has(legacyId)) evidenceCache.set(legacyId, await collectEvidence(guild, legacyId));
              try { await resolveMessage(message, guild, { evidence: evidenceCache.get(legacyId) }); status.recovered++; }
              catch { status.errors++; }
            }
            const next = [...messages.keys()].reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
            if (next === before || messages.size < 100) break;
            before = next;
          }
          status.channels++;
        } catch { status.errors++; }
      }
      status.state = 'complete';
      status.finishedAt = new Date().toISOString();
      logger.info('اكتمل فحص اللوحات القديمة', { guildId, ...status });
    })().catch(error => { status.state = 'failed'; status.errors++; logger.error('تعذر استكمال استرجاع اللوحات', { guildId, code: error.code, message: error.message }); });
    return status;
  }

  return { getPanel, listPanels, savePanel, postPanel, resolveMessage, getDiscoveryStatus, startDiscovery, buildMessage };
}
