import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Colors,
  EmbedBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder
} from 'discord.js';
import { TicketPanel } from '../models/ticketPanel.js';
import { StaffStats } from '../models/staffStats.js';

function hexToDecimalColor(hex) {
  if (!hex) return Colors.Blurple;
  const cleaned = hex.replace('#', '');
  return parseInt(cleaned, 16);
}

export function createTicketService({ client, logger }) {
  const ticketTopicRegex = /ticket:(\d+):panel:(.+)/;

  async function ensureManagePermission(channel) {
    const me = await channel.guild.members.fetchMe();
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.ManageChannels)) {
      throw new Error('البوت يحتاج صلاحية Stark Ticket في السيرفر');
    }
  }

  function parseTicketTopic(topic) {
    if (!topic) return null;
    const match = topic.match(ticketTopicRegex);
    if (!match) return null;
    return { userId: match[1], panelId: match[2] };
  }

  async function getChannelContext(channel) {
    const meta = parseTicketTopic(channel.topic);
    if (!meta) throw new Error('لا يمكن تحديد مالك التذكرة من إعدادات القناة');
    const panel = await TicketPanel.findById(meta.panelId);
    if (!panel) throw new Error('تعذر العثور على إعداد اللوحة المرتبطة');
    return { ownerId: meta.userId, panel };
  }

  async function savePanel(guildId, data) {
    const payload = { ...data };
    if (payload.embedColor && typeof payload.embedColor === 'string') {
      payload.embedColor = hexToDecimalColor(payload.embedColor);
    }
    payload.ticketCategoryId = payload.ticketCategoryId || undefined;
    payload.staffRoleIds = Array.isArray(payload.staffRoleIds)
      ? payload.staffRoleIds.filter(Boolean)
      : [];
    payload.menuOptions = Array.isArray(payload.menuOptions)
      ? payload.menuOptions
          .filter((opt) => opt && opt.label && opt.value)
          .map((opt) => {
            const desc = typeof opt.description === 'string' ? opt.description.trim() : undefined;
            return {
              label: opt.label.trim(),
              value: opt.value.trim(),
              description: desc ? desc.slice(0, 100) : undefined
            };
          })
      : [];

    const valueCounts = payload.menuOptions.reduce((acc, o) => {
      acc[o.value] = (acc[o.value] || 0) + 1;
      return acc;
    }, {});
    const duplicates = Object.keys(valueCounts).filter((k) => valueCounts[k] > 1);
    if (duplicates.length) {
      throw new Error(
        `قيمة الخيار يجب أن تكون فريدة. القيم المكررة: ${duplicates.join(', ')}`
      );
    }
    if (typeof payload.embedImageUrl === 'string') {
      payload.embedImageUrl = payload.embedImageUrl.trim() || undefined;
    }
    if (typeof payload.ticketMessage === 'string') {
      payload.ticketMessage = payload.ticketMessage.trim().slice(0, 1024);
    }
    if (typeof payload.selectPlaceholder === 'string') {
      const ph = payload.selectPlaceholder.trim();
      payload.selectPlaceholder = ph ? ph.slice(0, 100) : undefined;
    }
    if (typeof payload.panelContent === 'string') {
      const pc = payload.panelContent.trim();
      payload.panelContent = pc ? pc.slice(0, 2000) : undefined;
    }

    const setFields = {
      guildId,
      channelId: payload.channelId,
      embedTitle: payload.embedTitle,
      embedDescription: payload.embedDescription,
      embedColor: payload.embedColor,
      staffRoleIds: payload.staffRoleIds,
      menuOptions: payload.menuOptions
    };
    const unsetFields = {};
    for (const key of [
      'embedImageUrl',
      'ticketMessage',
      'selectPlaceholder',
      'panelContent',
      'ticketCategoryId',
      'claimLogChannelId',
      'closeLogChannelId'
    ]) {
      if (payload[key] === undefined) {
        unsetFields[key] = '';
      } else {
        setFields[key] = payload[key];
      }
    }

    const update = Object.keys(unsetFields).length
      ? { $set: setFields, $unset: unsetFields }
      : { $set: setFields };

    const panel = await TicketPanel.findOneAndUpdate({ guildId }, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    });
    logger.info?.(
      `[TicketPanel] Saved guild=${guildId}, options=${panel.menuOptions.length}, roles=${panel.staffRoleIds.length}, category=${panel.ticketCategoryId ?? 'none'}`
    );
    return panel;
  }

  async function postPanel(guildId) {
    const panel = await TicketPanel.findOne({ guildId });
    if (!panel) throw new Error('لا يوجد إعداد للوحة التذاكر');
    logger.info?.(
      `[TicketPanel] Publish guild=${guildId}, options=${panel.menuOptions.length}, roles=${panel.staffRoleIds.length}, category=${panel.ticketCategoryId ?? 'none'}`
    );

    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(panel.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error('القناة المحددة غير صالحة أو ليست نصية');
    }

    await ensureManagePermission(channel);

    const embed = new EmbedBuilder()
      .setTitle(panel.embedTitle)
      .setDescription(panel.embedDescription)
      .setColor(panel.embedColor ?? Colors.Blurple);
    if (panel.embedImageUrl) {
      embed.setImage(panel.embedImageUrl);
    }

    const options = panel.menuOptions
      .slice(0, 25)
      .map((opt, idx) => {
        const desc = typeof opt.description === 'string' ? opt.description.trim() : undefined;
        return {
          label: opt.label || `خيار ${idx + 1}`,
          value: opt.value || `option_${idx + 1}`,
          description: desc ? desc.slice(0, 100) : undefined
        };
      });
    if (!options.length) {
      throw new Error('يجب إضافة خيار واحد على الأقل للقائمة.');
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`ticket-panel:${panel.id}`)
      .setPlaceholder(panel.selectPlaceholder || 'اختر نوع التذكرة')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(...options);

    const row = new ActionRowBuilder().addComponents(menu);
    const message = await channel.send({
      content: panel.panelContent,
      embeds: [embed],
      components: [row]
    });
    panel.messageId = message.id;
    await panel.save();

    return panel;
  }

  async function handleSelectInteraction(interaction) {
    // Defer immediately — channel creation + DB ops exceed Discord's 3-second limit
    await interaction.deferReply({ flags: 64 });

    const panelId = interaction.customId.split(':')[1];
    const panel = await TicketPanel.findById(panelId);
    if (!panel) {
      await interaction.editReply({ content: 'لوحة التذاكر غير موجودة.' });
      return;
    }

    const guild = interaction.guild;
    const parentId = panel.ticketCategoryId ?? null;
    const permissionOverwrites = [
      { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
      },
      ...(panel.staffRoleIds ?? []).map((roleId) => ({
        id: roleId,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
      }))
    ];

    let ticketChannel;
    try {
      const createOptions = {
        name: `ticket-${interaction.user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites
      };
      if (parentId) {
        createOptions.parent = parentId;
      }
      ticketChannel = await guild.channels.create(createOptions);
    } catch (err) {
      await interaction.editReply({
        content: 'تعذر فتح التذكرة. تأكد من صلاحية Stark Ticket للبوت وصحة التصنيف المختار.'
      });
      throw err;
    }
    await ticketChannel.setTopic(`ticket:${interaction.user.id}:panel:${panel.id}`);

    const selectedValue = interaction.values[0];
    const matchedOption = (panel.menuOptions || []).find((o) => o.value === selectedValue);
    const displayText = matchedOption?.label || selectedValue;

    const embed = new EmbedBuilder()
      .setTitle(`🎟️ ${displayText}`)
      .setDescription(panel.ticketMessage || 'يرجى وصف مشكلتك وسيقوم الفريق بمساعدتك قريبًا.')
      .setColor(panel.embedColor ?? Colors.Blurple)
      .addFields(
        { name: 'صاحب التذكرة', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'القائمة المختارة', value: displayText, inline: true }
      );

    const staffRoles = panel.staffRoleIds ?? [];
    const staffMentions = staffRoles.map((roleId) => `<@&${roleId}>`).join(' ');

    const buttonsRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:close')
        .setLabel('Close')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('ticket:come')
        .setLabel('Come')
        .setEmoji('📣')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('ticket:claim')
        .setLabel('Claim')
        .setEmoji('📝')
        .setStyle(ButtonStyle.Success)
    );

    const sentOpenMessage = await ticketChannel.send({
      content: `${staffMentions}${staffMentions ? ' - ' : ''}<@${interaction.user.id}>`,
      embeds: [embed],
      components: [buttonsRow],
      allowedMentions: {
        parse: [],
        roles: staffRoles,
        users: [interaction.user.id]
      }
    });
    try {
      await sentOpenMessage.pin();
    } catch (e) {
      logger.error('تعذر تثبيت رسالة فتح التذكرة', e);
    }
    await interaction.editReply({ content: `تم فتح تذكرة: ${ticketChannel}` });
  }

  function memberHasStaffRole(member, panel) {
    return (panel.staffRoleIds ?? []).some((roleId) => member.roles.cache.has(roleId));
  }

  async function handleTicketButton(interaction) {
    if (!['ticket:close', 'ticket:come', 'ticket:claim'].includes(interaction.customId)) return;
    try {
      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) return;
      const { ownerId, panel } = await getChannelContext(channel);
      const isStaff = interaction.member ? memberHasStaffRole(interaction.member, panel) : false;
      const isOwner = interaction.user.id === ownerId;
      if (!isStaff && !isOwner) {
        await interaction.reply({ content: 'ليس لديك صلاحية لإدارة هذه التذكرة.', flags: 64 });
        return;
      }

      if (interaction.customId === 'ticket:close') {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: 64 });
        }
        await channel.send(`تم إغلاق التذكرة بواسطة <@${interaction.user.id}>.`);
        await interaction.editReply({ content: 'سيتم إغلاق التذكرة خلال 3 ثوان.' });
        try {
          const logId = panel.closeLogChannelId;
          if (logId) {
            const logCh = await channel.guild.channels.fetch(logId).catch(() => null);
            if (logCh?.type === ChannelType.GuildText) {
              const closeEmbed = new EmbedBuilder()
                .setTitle('إغلاق تذكرة')
                .setColor(Colors.Red)
                .addFields(
                  { name: 'القناة', value: `${channel}`, inline: true },
                  { name: 'صاحب التذكرة', value: `<@${ownerId}>`, inline: true },
                  { name: 'المغلق', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp(new Date());
              await logCh.send({ embeds: [closeEmbed] });
            }
          }
        } catch (e) {
          logger.error('فشل إرسال لوج الإغلاق', e);
        }
        setTimeout(() => {
          channel.delete('Ticket closed').catch((err) => logger.error('تعذر حذف قناة التذكرة', err));
        }, 3000);
      } else if (interaction.customId === 'ticket:come') {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: 64 });
        }
        try {
          const user = await client.users.fetch(ownerId);
          await user.send(
            `الطاقم يطلب حضورك إلى التذكرة: ${channel.name}\n${channel.url ?? ''}`
          );
          await interaction.editReply({ content: 'تم إرسال تذكير للمستخدم.' });
        } catch (error) {
          logger.error('فشل إرسال التذكير', error);
          await interaction.editReply({ content: 'تعذر إرسال رسالة خاصة للمستخدم.' });
        }
      } else if (interaction.customId === 'ticket:claim') {
        if (!isStaff) {
          await interaction.reply({ content: 'زر الاستلام مخصص لأعضاء الطاقم فقط.', flags: 64 });
          return;
        }
        const alreadyClaimed = interaction.message.components?.some((row) =>
          row.components?.some((c) => c.customId === 'ticket:claim' && c.disabled)
        );
        if (alreadyClaimed) {
          await interaction.reply({ content: 'تم استلام هذه التذكرة مسبقًا.', flags: 64 });
          return;
        }
        await interaction.deferUpdate();
        const newRows = interaction.message.components.map((r) => {
          const newRow = new ActionRowBuilder();
          for (const c of r.components) {
            if (c.type === 2) {
              const btn = ButtonBuilder.from(c);
              if (btn.data.custom_id === 'ticket:claim') {
                btn.setDisabled(true).setLabel('Claimed');
              }
              newRow.addComponents(btn);
            }
          }
          return newRow;
        });
        await interaction.message.edit({ components: newRows });
        await channel.send(`تم استلام التذكرة بواسطة <@${interaction.user.id}>.`);
        await interaction.channel.setName(`claimed-${interaction.user.username}`);
        try {
          const stats = await StaffStats.findOneAndUpdate(
            { guildId: channel.guild.id, userId: interaction.user.id },
            { $inc: { claimedCount: 1 } },
            { upsert: true, new: true }
          );
          const logId = panel.claimLogChannelId;
          if (logId) {
            const logCh = await channel.guild.channels.fetch(logId).catch(() => null);
            if (logCh?.type === ChannelType.GuildText) {
              const claimEmbed = new EmbedBuilder()
                .setTitle('استلام تذكرة')
                .setColor(Colors.Green)
                .addFields(
                  { name: 'القناة', value: `${channel}`, inline: true },
                  { name: 'المستلم', value: `<@${interaction.user.id}>`, inline: true },
                  { name: 'صاحب التذكرة', value: `<@${ownerId}>`, inline: true },
                  { name: 'عدد التذاكر المستلمة', value: `${stats.claimedCount}`, inline: true }
                )
                .setTimestamp(new Date());
              await logCh.send({ embeds: [claimEmbed] });
            }
          }
        } catch (e) {
          logger.error('فشل تحديث إحصائيات الاستلام أو إرسال اللوج', e);
        }
      }
    } catch (error) {
      logger.error('خطأ أثناء التعامل مع أزرار التذاكر', error);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: 'حدث خطأ داخلي.', ephemeral: true });
      }
    }
  }

  return {
    savePanel,
    postPanel,
    handleSelectInteraction,
    handleTicketButton
  };
}
