import { Collection, ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { SECTORS } from '../src/config/sectors.js';

export const GUILD = '1378729600000000000';
export const USER = '1378729600000000001';
export const BOT = '1378729600000000002';
export const POLICE_CATEGORY = '1378729600000000010';
export const MECHANIC_CATEGORY = '1378729600000000011';
export const PANEL_CHANNEL = '1378729600000000020';
export const SECOND_CHANNEL = '1378729600000000021';
export const PANEL_ID = '68ca00000000000000000001';
export const SECOND_ID = '68ca00000000000000000002';
export const logger = { info() {}, error() {} };
let counter = 1378729600000010000n;
export const nextId = () => String(counter++);

export function role(id, position, name = id, extra = {}) {
  return { id, position, name, managed: false, editable: true, guild: { id: GUILD },
    comparePositionTo(other) { return this.position - other.position; }, ...extra };
}
export function makeRoles() {
  const roles = new Collection();
  roles.set(GUILD, role(GUILD, 0, '@everyone'));
  SECTORS.forEach((s, i) => {
    const offset = 1 + i * 10;
    for (const [id, pos, name] of [[s.firstRoleId, offset, `${s.name} أول رتبة`], [s.lastRoleId, offset + 6, `${s.name} آخر رتبة`], [s.managerRoleId, s.managerRoleId === s.lastRoleId ? offset + 6 : offset + 3, `مسؤول ${s.name}`]]) roles.set(id, role(id, pos, name));
    const middle = `100000000000000000${i}`;
    roles.set(middle, role(middle, offset + 2, `${s.name} رتبة وسطية`));
  });
  return roles;
}
export function member(id, roleIds = [], extra = {}) {
  const cache = new Collection(roleIds.map(r => [r, role(r, 1)]));
  const calls = [];
  const result = { id, user: { id, username: `member-${id}`, bot: false }, displayName: `عضو ${id}`,
    permissions: new PermissionsBitField(), manageable: true,
    roles: { cache, calls,
      async add(id) { calls.push(['add', id]); cache.set(id, role(id, 1)); },
      async remove(id) { calls.push(['remove', id]); cache.delete(id); }
    }, ...extra };
  return result;
}
export function makeDiscord() {
  const roles = makeRoles();
  const bot = member(BOT, [], { permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]) });
  bot.roles.highest = role('1378729600000000003', 100, 'البوت');
  const members = new Collection([[BOT, bot], [USER, member(USER)]]);
  const channels = new Collection();
  const created = [], sent = [], deleted = [], edited = [];
  const guild = { id: GUILD, name: 'ستارك التجريبي', roles: { cache: roles, async fetch() { return roles; } },
    members: { async fetchMe() { return bot; }, async fetch(input) { const id = typeof input === 'string' ? input : input.user; return members.get(id) || member(id); } },
    commands: { async create() {} },
    channels: { cache: channels,
      async fetch(id) { return id ? channels.get(id) || null : channels; },
      async create(options) { const channel = textChannel(nextId(), options); created.push({ ...options, channel }); channels.set(channel.id, channel); return channel; }
    }
  };
  function message(channel, data = {}) {
    const payload = data.embeds ? data : { ...data, embeds: [] };
    const msg = { id: data.id || nextId(), channelId: channel.id, guildId: GUILD, channel, author: { id: BOT }, content: payload.content || '',
      embeds: payload.embeds.map(e => e.toJSON ? e.toJSON() : e),
      components: (payload.components || []).map(r => ({ components: (r.toJSON ? r.toJSON() : r).components.map(c => ({ ...c, customId: c.customId || c.custom_id })) })),
      async edit(next) { edited.push({ id: this.id, ...next }); Object.assign(this, message(channel, { ...this, ...next, id: this.id })); return this; },
      async pin() { channel._pins.push(this); }
    };
    channel._messages.set(msg.id, msg);
    return msg;
  }
  function textChannel(id, data = {}) {
    const overwrites = new Collection((data.permissionOverwrites || []).map(o => [o.id, { ...o, type: o.type ?? (o.id === BOT || o.id === USER ? 1 : 0), allow: new PermissionsBitField(o.allow || []), deny: new PermissionsBitField(o.deny || []) }]));
    const ch = { id, name: data.name || 'tickets', guild, type: ChannelType.GuildText, parentId: data.parent || null, topic: data.topic || null,
      url: `https://discord.com/channels/${GUILD}/${id}`, createdAt: new Date(), permissionOverwrites: { cache: overwrites },
      _messages: new Collection(), _pins: [], permissionsFor() { return new PermissionsBitField([PermissionFlagsBits.Administrator]); },
      messages: { async fetch(input = {}) {
        const id = typeof input === 'string' ? input : input.message;
        if (id) { const m = ch._messages.get(id); if (!m) throw Object.assign(new Error('Unknown message'), { code: 10008 }); return m; }
        return new Collection([...ch._messages].filter(([id]) => !input.before || BigInt(id) < BigInt(input.before)).sort(([a], [b]) => BigInt(a) > BigInt(b) ? -1 : 1).slice(0, input.limit || 100));
      }, async fetchPins() { return { items: ch._pins.map(message => ({ message })) }; } },
      async send(payload) { sent.push(payload); return message(ch, payload); },
      async edit(options) { edited.push({ channelId: ch.id, ...options }); if (options.name) ch.name = options.name; if (Object.hasOwn(options, 'parent')) ch.parentId = options.parent; return ch; },
      async delete() { deleted.push(id); channels.delete(id); }
    };
    return ch;
  }
  for (const [id, name] of [[POLICE_CATEGORY, 'الشرطة'], [MECHANIC_CATEGORY, 'الميكانيكي']]) channels.set(id, { id, name, type: ChannelType.GuildCategory, children: { cache: new Collection() }, permissionsFor: () => bot.permissions });
  channels.set(PANEL_CHANNEL, textChannel(PANEL_CHANNEL)); channels.set(SECOND_CHANNEL, textChannel(SECOND_CHANNEL));
  const client = { user: { id: BOT, tag: 'STARK#0001' }, isReady: () => true, guilds: { cache: new Collection([[GUILD, guild]]), async fetch(id) { if (id !== GUILD) throw new Error('Unknown guild'); return guild; } }, users: { async fetch(id) { return { id, async send() {} }; } } };
  return { client, guild, bot, roles, members, channels, created, sent, deleted, edited, textChannel, message };
}
export function panelData(overrides = {}) {
  return { name: 'الشرطة', channelId: PANEL_CHANNEL, embedTitle: 'الشرطة', embedDescription: 'فتح طلب في الشرطة', embedColor: '#3b82f6', ticketCategoryId: POLICE_CATEGORY,
    staffRoleIds: [SECTORS[0].managerRoleId], menuOptions: [{ label: 'دعم الشرطة', value: 'police', description: '' }], ...overrides };
}
export function interaction(discord, message, value = 'police', userId = USER) {
  const replies = [];
  return { guild: discord.guild, guildId: GUILD, channel: message.channel, channelId: message.channelId, message, customId: message.components?.[0]?.components?.[0]?.customId,
    user: { id: userId, username: 'test' }, values: [value], replies, inGuild: () => true,
    async deferReply() { this.deferred = true; }, async editReply(data) { replies.push(data); }, async reply(data) { replies.push(data); }
  };
}
