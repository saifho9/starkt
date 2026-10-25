import { AppError, requireId } from '../utils/errors.js';
import { randomUUID } from 'node:crypto';

const optionalFields = ['ticketCategoryId', 'claimLogChannelId', 'closeLogChannelId', 'embedImageUrl', 'ticketMessage', 'selectPlaceholder', 'panelContent'];
const text = (v, max, field, required = false) => {
  if (typeof v !== 'string' || (required && !v.trim()) || v.length > max) throw new AppError(`${field}: أدخل نصًا ${required ? 'غير فارغ ' : ''}بحد أقصى ${max} حرف.`);
  return v.trim();
};
export function normalizePanel(data, existing = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('بيانات اللوحة غير صالحة.');
  const p = { ...existing };
  for (const [key, max, label] of [['name', 100, 'اسم اللوحة'], ['embedTitle', 256, 'العنوان'], ['embedDescription', 4096, 'الوصف']]) {
    if (Object.hasOwn(data, key)) p[key] = text(data[key], max, label, key !== 'name');
  }
  if (!p.embedTitle || !p.embedDescription) throw new AppError('أدخل عنوان اللوحة ووصفها.');
  p.name ||= p.embedTitle;
  if (Object.hasOwn(data, 'channelId')) p.channelId = requireId(data.channelId, 'قناة اللوحة');
  requireId(p.channelId, 'قناة اللوحة');
  if (Object.hasOwn(data, 'embedColor')) {
    const color = data.embedColor;
    p.embedColor = typeof color === 'string' && /^#[a-f\d]{6}$/i.test(color) ? parseInt(color.slice(1), 16) : color;
    if (!Number.isInteger(p.embedColor) || p.embedColor < 0 || p.embedColor > 0xffffff) throw new AppError('لون اللوحة غير صالح.');
  }
  p.embedColor ??= 0x5865f2;
  for (const key of optionalFields) {
    if (!Object.hasOwn(data, key)) continue;
    const value = data[key] ?? '';
    if (typeof value !== 'string') throw new AppError(`${key}: قيمة غير صالحة.`);
    if (key.endsWith('Id') && value) requireId(value);
    p[key] = text(value, key === 'panelContent' ? 2000 : key === 'selectPlaceholder' ? 150 : key === 'ticketMessage' ? 4000 : 2048, key);
  }
  if (p.embedImageUrl) {
    let url;
    try { url = new URL(p.embedImageUrl); } catch { throw new AppError('رابط الصورة غير صالح.'); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new AppError('رابط الصورة يجب أن يبدأ بـ https أو http.');
  }
  if (Object.hasOwn(data, 'staffRoleIds')) p.staffRoleIds = normalizeRoleIds(data.staffRoleIds);
  p.staffRoleIds ??= [];
  if (Object.hasOwn(data, 'menuOptions')) {
    if (!Array.isArray(data.menuOptions) || !data.menuOptions.length || data.menuOptions.length > 25) throw new AppError('أضف من خيار واحد إلى 25 خيارًا للقائمة.');
    p.menuOptions = data.menuOptions.map(o => {
      if (!o || typeof o !== 'object') throw new AppError('خيار القائمة غير صالح.');
      const result = { label: text(o.label, 100, 'عنوان الخيار', true), value: text(o.value || randomUUID(), 100, 'قيمة الخيار', true), description: text(o.description ?? '', 100, 'وصف الخيار') };
      if (o.ticketCategoryId) result.ticketCategoryId = requireId(o.ticketCategoryId, 'تصنيف الخيار');
      if (o.staffRoleIds !== undefined && o.staffRoleIds !== null) result.staffRoleIds = normalizeRoleIds(o.staffRoleIds);
      return result;
    });
  }
  if (!p.menuOptions?.length) throw new AppError('أضف خيارًا واحدًا على الأقل.');
  if (new Set(p.menuOptions.map(o => o.value)).size !== p.menuOptions.length) throw new AppError('قيم خيارات القائمة يجب أن تكون مختلفة.');
  // لا نقبل حقول هوية/رسائل/سيرفر قادمة من المتصفح.
  return Object.fromEntries(['name', 'channelId', 'embedTitle', 'embedDescription', 'embedColor', 'staffRoleIds', 'menuOptions', ...optionalFields].filter(k => p[k] !== undefined).map(k => [k, p[k]]));
}
export function normalizeRoleIds(ids) {
  if (!Array.isArray(ids) || ids.length > 50) throw new AppError('قائمة رتب الطاقم غير صالحة.');
  return [...new Set(ids.map(id => requireId(id, 'رتبة الطاقم')))];
}
export function getOptionRoute(panel, value) {
  const option = panel.menuOptions?.find(o => o.value === value);
  if (!option) throw new AppError('الخيار لم يعد موجودًا. افتح قائمة اللوحة المحدثة.');
  return { option, categoryId: option.ticketCategoryId || panel.ticketCategoryId || null, staffRoleIds: option.staffRoleIds ?? panel.staffRoleIds ?? [] };
}
export function parseTicketTopic(topic) {
  const match = typeof topic === 'string' && topic.match(/^ticket:(\d{17,20}):panel:([a-f\d]{24})(?:$|\s)/i);
  return match ? { ownerId: match[1], panelId: match[2] } : null;
}
export function plain(doc) { return doc?.toObject ? doc.toObject() : doc; }
export function snapshot(panel) {
  return JSON.parse(JSON.stringify(plain(panel)));
}
