import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { TicketPanel } from '../models/ticketPanel.js';
import { StaffStats } from '../models/staffStats.js';
import { Ticket } from '../models/ticket.js';
import { AppError, requireId } from '../utils/errors.js';
import { createSerialQueue } from '../utils/locks.js';
import { getOptionRoute, parseTicketTopic, plain, snapshot } from './ticketConfig.js';
import { getOpeningMessage, isText, selectedLabelFromMessage, visibleStaffRoleIds } from './discordHelpers.js';

const allowedMentions = { parse: [] };
const safeName = name => String(name).replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 85) || 'member';
export function ticketButtons(claimed = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:close').setLabel('إغلاق التذكرة').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket:come').setLabel('استدعاء صاحب التذكرة').setEmoji('📣').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket:claim').setLabel(claimed ? 'تم الاستلام' : 'استلام التذكرة').setEmoji('📝').setStyle(ButtonStyle.Success).setDisabled(claimed)
  );
}

export function createTicketService({ client, logger, panelService, models = { TicketPanel, StaffStats, Ticket } }) {
  const Panels = models.TicketPanel;
  const Stats = models.StaffStats;
  const Tickets = models.Ticket;
  const serialize = createSerialQueue();

  async function importChannel(channel) {
    const existing = await Tickets.findOne({ guildId: channel.guild.id, channelId: channel.id });
    if (existing) return existing;
    const meta = parseTicketTopic(channel.topic);
    if (!meta) throw new AppError('هذه القناة ليست تذكرة معروفة.');
    const original = await Panels.findOne({ _id: meta.panelId, guildId: channel.guild.id });
    let opening;
    try { opening = await getOpeningMessage(channel, client.user.id); }
    catch (error) { logger.error('تعذر قراءة رسالة التذكرة القديمة', { channelId: channel.id, code: error.code }); }
    const label = selectedLabelFromMessage(opening);
    // صلاحيات القناة الفعلية تحفظ طاقم التيكت القديم حتى لو تغير سجل اللوحة.
    const staffRoleIds = visibleStaffRoleIds(channel);
    const siblings = await Panels.find({ guildId: channel.guild.id, legacyPanelId: meta.panelId }).lean();
    const matching = siblings.filter(p => p.menuOptions.some(o => o.label === label
      && (o.ticketCategoryId || p.ticketCategoryId || null) === channel.parentId));
    const chosen = matching.length === 1 ? matching[0] : plain(original);
    const opt = chosen?.menuOptions?.find(o => o.label === label);
    const claimed = opening?.components?.flatMap(r => r.components).some(c => c.customId === 'ticket:claim' && c.disabled);
    try {
      return await Tickets.create({
        guildId: channel.guild.id, channelId: channel.id, ownerId: meta.ownerId,
        panelId: chosen?._id || meta.panelId, selectedValue: opt?.value || '', selectedLabel: label,
        staffRoleIds, settings: chosen ? snapshot(chosen) : {},
        openingMessageId: opening?.id, state: 'open', claimedBy: claimed ? 'legacy-claimed' : null
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      return Tickets.findOne({ guildId: channel.guild.id, channelId: channel.id });
    }
  }
  async function existingTicketReply(interaction, doc, guild) {
    if (!doc) return false;
    if (doc.channelId) {
      let channel;
      try { channel = await guild.channels.fetch(doc.channelId); }
      catch (error) { if (error.code !== 10003) throw error; }
      if (channel) {
        await interaction.editReply({ content: `لديك تذكرة مفتوحة لهذا القسم: ${channel}`, allowedMentions });
        return true;
      }
      await Tickets.updateOne({ _id: doc._id }, { $set: { state: 'closed', closedAt: new Date() }, $unset: { activeKey: '' } });
      return false;
    }
    if (Date.now() - new Date(doc.createdAt).getTime() < 120_000) {
      await interaction.editReply({ content: 'جارٍ فتح تذكرتك. انتظر قليلًا قبل إعادة المحاولة.' });
      return true;
    }
    // تعافٍ من إعادة تشغيل حدثت بين إنشاء القناة وحفظ رقمها.
    await guild.channels.fetch();
    const prefix = `ticket:${doc.ownerId}:panel:${doc.panelId} option:${encodeURIComponent(doc.selectedValue)}`;
    const orphan = guild.channels.cache.find(c => c.topic === prefix);
    if (orphan) {
      await Tickets.updateOne({ _id: doc._id }, { $set: { channelId: orphan.id, state: 'open' } });
      await interaction.editReply({ content: `تذكرتك موجودة بالفعل: ${orphan}`, allowedMentions });
      return true;
    }
    await Tickets.updateOne({ _id: doc._id, state: 'opening' }, { $set: { state: 'closed' }, $unset: { activeKey: '' } });
    return false;
  }

  async function handleSelectInteraction(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.inGuild()) throw new AppError('افتح التذكرة من داخل السيرفر.');
    const guild = interaction.guild;
    const panel = await panelService.resolveMessage(interaction.message, guild);
    if (panel.guildId !== guild.id) throw new AppError('اللوحة لا تخص هذا السيرفر.');
    if (panel.needsReview) throw new AppError('هذه اللوحة القديمة تحتاج مراجعة وجهتها في لوحة التحكم. تم إيقاف فتح التذاكر منها مؤقتًا لتجنب فتحها في قطاع خاطئ.');
    const { option, categoryId, staffRoleIds } = getOptionRoute(panel, interaction.values[0]);
    const activeKey = `${guild.id}:${panel._id}:${interaction.user.id}:${option.value}`;
    return serialize(`open:${activeKey}`, async () => {
      const previous = await Tickets.findOne({ activeKey });
      if (await existingTicketReply(interaction, previous, guild)) return;
      // التقاط تيكت قديم قبل الترقية لنفس العضو والقسم بدل إنشاء نسخة أخرى.
      const channels = await guild.channels.fetch();
      for (const c of channels.values()) {
        const meta = parseTicketTopic(c?.topic);
        if (!isText(c) || meta?.ownerId !== interaction.user.id || c.parentId !== categoryId
          || ![String(panel._id), panel.legacyPanelId].filter(Boolean).includes(meta.panelId)) continue;
        const imported = await importChannel(c);
        if (imported.selectedValue === option.value || imported.selectedLabel === option.label) {
          if (await existingTicketReply(interaction, imported, guild)) return;
        }
      }
      const [me, roles] = await Promise.all([guild.members.fetchMe(), guild.roles.fetch()]);
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) throw new AppError('البوت يحتاج صلاحية إدارة القنوات لفتح التذكرة.');
      if (staffRoleIds.some(id => id === guild.id || !roles.has(id))) throw new AppError('إحدى رتب طاقم اللوحة محذوفة أو غير صالحة. راجع إعدادات هذه اللوحة.');
      if (categoryId) {
        const category = channels.get(categoryId);
        if (category?.type !== ChannelType.GuildCategory) throw new AppError('تصنيف هذه التذكرة غير موجود. راجع اللوحة.');
        if (!category.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)) throw new AppError('البوت لا يملك صلاحية إدارة القنوات داخل تصنيف هذه التذكرة.');
        if (category.children.cache.size >= 50) throw new AppError('تصنيف التذاكر ممتلئ. أبلغ الإدارة لتوفير مكان.');
      }
      let reservation;
      try {
        reservation = await Tickets.create({
          guildId: guild.id, ownerId: interaction.user.id, panelId: panel._id,
          selectedValue: option.value, selectedLabel: option.label,
          staffRoleIds, settings: snapshot(panel), activeKey, state: 'opening'
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
        await existingTicketReply(interaction, await Tickets.findOne({ activeKey }), guild);
        return;
      }
      const memberPerms = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks];
      let channel;
      try {
        channel = await guild.channels.create({
          name: `ticket-${safeName(interaction.user.username)}`, type: ChannelType.GuildText,
          ...(categoryId ? { parent: categoryId } : {}),
          topic: `ticket:${interaction.user.id}:panel:${panel._id} option:${encodeURIComponent(option.value)}`,
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: me.id, allow: [...memberPerms, PermissionFlagsBits.ManageChannels] },
            { id: interaction.user.id, allow: memberPerms },
            ...staffRoleIds.map(id => ({ id, allow: memberPerms }))
          ], reason: `Ticket ${panel._id}/${option.value} for ${interaction.user.id}`
        });
        await Tickets.updateOne({ _id: reservation._id }, { $set: { channelId: channel.id, state: 'open' } });
      } catch (error) {
        // لا نحذف قناة أُنشئت بالفعل بسبب عطل لاحق في قاعدة البيانات.
        if (!channel) await Tickets.updateOne({ _id: reservation._id }, { $set: { state: 'closed' }, $unset: { activeKey: '' } });
        logger.error('تعذر إكمال فتح تذكرة', { code: error.code, channelId: channel?.id, panelId: panel._id });
        if (!channel) throw new AppError('تعذر إنشاء التذكرة. راجع صلاحيات البوت والتصنيف ثم حاول مرة أخرى.');
      }
      try {
        const embed = new EmbedBuilder().setTitle(`🎟️ ${option.label}`).setDescription(panel.ticketMessage || 'يرجى وصف مشكلتك وسيقوم الفريق بمساعدتك قريبًا.')
          .setColor(panel.embedColor ?? 0x5865f2)
          .addFields({ name: 'صاحب التذكرة', value: `<@${interaction.user.id}>`, inline: true }, { name: 'القائمة المختارة', value: option.label, inline: true });
        const message = await channel.send({
          content: `${staffRoleIds.map(id => `<@&${id}>`).join(' ')} <@${interaction.user.id}>`.trim(),
          embeds: [embed], components: [ticketButtons()], allowedMentions: { parse: [], roles: staffRoleIds, users: [interaction.user.id] }
        });
        await Tickets.updateOne({ _id: reservation._id }, { $set: { openingMessageId: message.id } });
        await message.pin().catch(() => {});
      } catch (error) { logger.error('التذكرة مفتوحة لكن تعذر إكمال رسالة الترحيب', { channelId: channel.id, code: error.code }); }
      await interaction.editReply({ content: `✅ تم فتح تذكرتك: ${channel}`, allowedMentions });
    });
  }

  async function sendLog(guild, channelId, title, fields, color) {
    if (!channelId) return;
    try {
      const log = await guild.channels.fetch(channelId);
      if (isText(log)) await log.send({ embeds: [new EmbedBuilder().setTitle(title).setColor(color).addFields(fields).setTimestamp()], allowedMentions });
    } catch (error) { logger.error('تعذر إرسال سجل التذكرة', { channelId, code: error.code }); }
  }
  async function handleTicketButton(interaction) {
    if (!['ticket:close', 'ticket:come', 'ticket:claim'].includes(interaction.customId)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.inGuild() || !isText(interaction.channel)) throw new AppError('استخدم أزرار التذكرة من قناتها.');
    return serialize(`ticket:${interaction.channelId}`, async () => {
      const channel = interaction.channel;
      const ticket = await importChannel(channel);
      const actor = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
      const isStaff = ticket.staffRoleIds.some(id => actor.roles.cache.has(id)) || actor.permissions.has(PermissionFlagsBits.Administrator);
      const isOwner = interaction.user.id === ticket.ownerId;
      if (!isStaff && !(isOwner && interaction.customId === 'ticket:close')) throw new AppError('هذا الزر مخصص لطاقم التذكرة. صاحب التذكرة يمكنه إغلاقها فقط.', 403);
      const baseFields = [
        { name: 'القناة', value: `<#${channel.id}>`, inline: true },
        { name: 'صاحب التذكرة', value: `<@${ticket.ownerId}>`, inline: true },
        { name: 'المسؤول', value: `<@${interaction.user.id}>`, inline: true }
      ];
      if (interaction.customId === 'ticket:claim') {
        const claimed = await Tickets.findOneAndUpdate({ _id: ticket._id, state: 'open', claimedBy: null }, { $set: { claimedBy: actor.id, claimedAt: new Date() } }, { new: true });
        if (!claimed) return interaction.editReply({ content: 'تم استلام هذه التذكرة بالفعل أو يجري إغلاقها.' });
        let count;
        try {
          const stats = await Stats.findOneAndUpdate({ guildId: channel.guild.id, userId: actor.id }, { $inc: { claimedCount: 1 } }, { upsert: true, new: true });
          count = stats.claimedCount;
        } catch (error) { logger.error('تعذر تحديث إحصائيات الاستلام', { channelId: channel.id, code: error.code }); }
        try {
          await interaction.message.edit({ components: [ticketButtons(true)] });
          await channel.send({ content: `تم استلام التذكرة بواسطة <@${actor.id}>.`, allowedMentions });
        } catch (error) { logger.error('تم حفظ الاستلام وتعذر تحديث رسالته', { channelId: channel.id, code: error.code }); }
        await sendLog(channel.guild, ticket.settings?.claimLogChannelId, 'استلام تذكرة', [...baseFields, ...(count !== undefined ? [{ name: 'عدد التذاكر المستلمة', value: String(count), inline: true }] : [])], 0x22c55e);
        return interaction.editReply({ content: '✅ تم استلام التذكرة.' });
      }
      if (interaction.customId === 'ticket:come') {
        try {
          const user = await client.users.fetch(ticket.ownerId);
          await user.send(`الطاقم يطلب حضورك إلى التذكرة: ${channel.name}\n${channel.url}`);
          return interaction.editReply({ content: 'تم إرسال تذكير لصاحب التذكرة.' });
        } catch { return interaction.editReply({ content: 'تعذر إرسال الرسالة الخاصة؛ قد تكون الرسائل الخاصة مغلقة عند العضو.' }); }
      }
      const closing = await Tickets.findOneAndUpdate({ _id: ticket._id, state: { $in: ['open', 'closing'] } }, { $set: { state: 'closing' } }, { new: true });
      if (!closing) throw new AppError('هذه التذكرة مغلقة بالفعل.');
      await interaction.editReply({ content: 'جارٍ إغلاق التذكرة…' });
      await sendLog(channel.guild, ticket.settings?.closeLogChannelId, 'إغلاق تذكرة', baseFields, 0xef4444);
      try { await channel.delete(`Ticket closed by ${actor.id}`); }
      catch (error) {
        if (error.code !== 10003) {
          await Tickets.updateOne({ _id: ticket._id }, { $set: { state: 'open' } });
          throw new AppError('تعذر إغلاق التذكرة. راجع صلاحية إدارة القنوات للبوت.');
        }
      }
      await Tickets.updateOne({ _id: ticket._id }, { $set: { state: 'closed', closedAt: new Date() }, $unset: { activeKey: '' } });
    });
  }

  async function listTickets(guildId) {
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const docs = await Tickets.find({ guildId, state: { $ne: 'closed' } }).lean();
    const byChannel = new Map(docs.filter(d => d.channelId).map(d => [d.channelId, d]));
    const result = [];
    for (const channel of channels.values()) {
      if (!isText(channel)) continue;
      const meta = parseTicketTopic(channel.topic);
      const doc = byChannel.get(channel.id);
      if (!meta && !doc) continue;
      result.push({
        id: channel.id, name: channel.name, categoryId: channel.parentId || '',
        categoryName: channels.get(channel.parentId)?.name || 'بدون تصنيف',
        ownerId: doc?.ownerId || meta?.ownerId, panelId: String(doc?.panelId || meta?.panelId || ''),
        selectedLabel: doc?.selectedLabel || '', claimedBy: doc?.claimedBy || null,
        url: channel.url, createdAt: channel.createdAt?.toISOString(), legacy: !doc
      });
    }
    return result.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  async function editTicket(guildId, channelId, data) {
    requireId(channelId, 'قناة التذكرة');
    return serialize(`ticket:${channelId}`, async () => {
      const guild = await client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(channelId);
      if (!isText(channel) || channel.guild.id !== guildId) throw new AppError('قناة التذكرة غير موجودة.', 404);
      const doc = await importChannel(channel);
      const changes = {};
      if (data.name !== undefined) {
        if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 100) throw new AppError('اسم التذكرة يجب أن يكون بين حرف و100 حرف.');
        changes.name = data.name.trim();
      }
      if (data.categoryId !== undefined) {
        if (data.categoryId) {
          requireId(data.categoryId, 'التصنيف');
          const parent = await guild.channels.fetch(data.categoryId);
          if (parent?.type !== ChannelType.GuildCategory) throw new AppError('اختر تصنيفًا صالحًا.');
        }
        changes.parent = data.categoryId || null;
        // النقل لا ينسخ صلاحيات تصنيف آخر ولا يغير من يستطيع رؤية التيكت.
        changes.lockPermissions = false;
      }
      if (!Object.keys(changes).length) throw new AppError('حدد الاسم أو التصنيف المطلوب تعديله.');
      await channel.edit({ ...changes, reason: 'Ticket dashboard edit' });
      return { ok: true, channelId, ticketId: String(doc._id) };
    });
  }
  return { handleSelectInteraction, handleTicketButton, listTickets, editTicket, importChannel };
}
