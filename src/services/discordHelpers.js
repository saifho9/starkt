import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { AppError } from '../utils/errors.js';

export const isText = channel => channel?.type === ChannelType.GuildText;
export function visibleStaffRoleIds(channel) {
  return [...channel.permissionOverwrites.cache.values()]
    .filter(o => o.type === 0 && o.id !== channel.guild.id && o.allow.has(PermissionFlagsBits.ViewChannel) && o.allow.has(PermissionFlagsBits.SendMessages))
    .map(o => o.id).sort();
}
export function isOpeningMessage(message, botId) {
  return message.author?.id === botId && message.embeds?.some(e => e.fields?.some(f => f.name === 'صاحب التذكرة'));
}
export async function getOpeningMessage(channel, botId) {
  try {
    const pins = await channel.messages.fetchPins({ limit: 50, cache: false });
    const found = pins.items.map(i => i.message).find(m => isOpeningMessage(m, botId));
    if (found) return found;
  } catch { /* التثبيت اختياري؛ نجرب سجل القناة أيضًا */ }
  const messages = await channel.messages.fetch({ after: channel.id, limit: 100, cache: false });
  return messages.find(m => isOpeningMessage(m, botId)) || null;
}
export function selectedLabelFromMessage(message) {
  const embed = message?.embeds?.find(e => e.fields?.some(f => f.name === 'القائمة المختارة'));
  return embed?.fields?.find(f => f.name === 'القائمة المختارة')?.value || '';
}
export async function fetchMessageIfExists(channel, messageId) {
  if (!messageId) return null;
  try { return await channel.messages.fetch({ message: messageId, force: true }); }
  catch (error) { if (error.code === 10008) return null; throw error; }
}
export async function checkTextChannel(guild, id, label) {
  let channel;
  try { channel = await guild.channels.fetch(id); }
  catch (error) { if (error.code !== 10003) throw error; }
  if (!isText(channel)) throw new AppError(`${label} غير موجودة أو ليست قناة نصية.`);
  return channel;
}
