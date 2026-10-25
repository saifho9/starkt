import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { SECTORS } from '../config/sectors.js';
import { AppError } from '../utils/errors.js';
import { createSerialQueue } from '../utils/locks.js';

export const giveCommand = new SlashCommandBuilder()
  .setName('give').setDescription('إدارة رتب قطاعك')
  .addSubcommand(sub => sub.setName('role').setDescription('إعطاء عضو رتبة أو أكثر من رتب قطاعك')
    .addUserOption(o => o.setName('member').setDescription('الشخص الذي سيحصل على الرتب').setRequired(true))
    .addStringOption(o => o.setName('roles').setDescription('منشن رتبة أو أكثر، مفصولة بمسافات: @رتبة1 @رتبة2').setMaxLength(1800).setRequired(true)));

export function parseRoleMentions(input) {
  if (typeof input !== 'string' || !input.trim()) throw new AppError('منشن الرتب المطلوبة في خانة roles.');
  const ids = [...input.matchAll(/<@&(\d{17,20})>|\b(\d{17,20})\b/g)].map(m => m[1] || m[2]);
  const rest = input.replace(/<@&\d{17,20}>|\b\d{17,20}\b/g, '').replace(/[\s,،]+/g, '');
  if (rest || !ids.length) throw new AppError('استخدم منشن الرتب فقط في خانة roles، مثل @رتبة1 @رتبة2؛ ويمكن أيضًا لصق معرفات الرتب.');
  const unique = [...new Set(ids)];
  if (unique.length > 25) throw new AppError('الحد الأقصى 25 رتبة في الأمر الواحد.');
  return unique;
}

export function getSectorRanges(roles, sectors = SECTORS) {
  return sectors.map(sector => {
    const first = roles.get(sector.firstRoleId);
    const last = roles.get(sector.lastRoleId);
    const manager = roles.get(sector.managerRoleId);
    const error = !first || !last || !manager ? 'إحدى رتب البداية أو النهاية أو المسؤول غير موجودة' : null;
    const lower = first && last && first.comparePositionTo(last) <= 0 ? first : last;
    const upper = lower === first ? last : first;
    return { ...sector, lower, upper, error };
  });
}

export function validateRoleGrant({ actor, target, bot, roles, requestedIds, sectors = SECTORS }) {
  const ranges = getSectorRanges(roles, sectors);
  const authorized = ranges.filter(s => actor.roles.cache.has(s.managerRoleId));
  if (!authorized.length) throw new AppError('هذا الأمر مخصص لمسؤولي القطاعات المحددين فقط.', 403);
  const broken = authorized.find(s => s.error);
  if (broken) throw new AppError(`تعذر تحديد رتب ${broken.name}: ${broken.error}. راجع معرفات الرتب.`);
  if (target.user.bot) throw new AppError('اختر عضوًا وليس بوتًا.');
  if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) throw new AppError('البوت يحتاج صلاحية إدارة الرتب.');
  return requestedIds.map(id => {
    const role = roles.get(id);
    if (!role || role.id === role.guild.id || role.managed) throw new AppError(`الرتبة <@&${id}> غير موجودة أو لا يمكن إعطاؤها يدويًا.`);
    const contains = s => !s.error && role.comparePositionTo(s.lower) >= 0 && role.comparePositionTo(s.upper) <= 0;
    const matches = ranges.filter(contains);
    // تداخل نطاقين يعني أن ترتيب الرتب لم يعد يعرّف قطاعًا واضحًا.
    if (matches.length !== 1) throw new AppError(`الرتبة ${role.name} خارج نطاقات القطاعات أو تقع في نطاقين متداخلين. راجع ترتيب رتب القطاعات.`);
    if (!authorized.some(s => s.id === matches[0].id)) throw new AppError(`لا يمكنك إعطاء رتبة ${role.name}؛ ليست من رتب قطاعك.`, 403);
    if (bot.roles.highest.comparePositionTo(role) <= 0 || !role.editable) throw new AppError(`ارفع رتبة البوت فوق رتبة ${role.name} أولًا.`);
    return role;
  });
}

export function createRoleService({ client, logger, sectors = SECTORS }) {
  const serialize = createSerialQueue();
  async function registerGuild(guild) {
    // إنشاء نفس الاسم يحدّث أمرنا فقط، دون حذف أي أوامر أخرى للبوت.
    await guild.commands.create(giveCommand.toJSON());
    logger.info(`تم تسجيل /give role في ${guild.name}`);
  }
  async function handle(interaction) {
    if (!interaction.inGuild()) throw new AppError('استخدم الأمر داخل السيرفر.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ids = parseRoleMentions(interaction.options.getString('roles', true));
    const user = interaction.options.getUser('member', true);
    return serialize(`${interaction.guildId}:${user.id}`, async () => {
      const guild = interaction.guild;
      const [roles, actor, target, bot] = await Promise.all([
        guild.roles.fetch(), guild.members.fetch({ user: interaction.user.id, force: true }),
        guild.members.fetch({ user: user.id, force: true }), guild.members.fetchMe({ force: true })
      ]);
      const requested = validateRoleGrant({ actor, target, bot, roles, requestedIds: ids, sectors });
      const missing = requested.filter(r => !target.roles.cache.has(r.id));
      if (!missing.length) return interaction.editReply({ content: 'العضو يمتلك كل الرتب المطلوبة بالفعل.', allowedMentions: { parse: [] } });
      const added = [];
      try {
        // إضافة رتبة منفردة تستخدم مسار Discord الذري، فلا تستبدل رتب العضو الأخرى.
        for (const role of missing) {
          await target.roles.add(role.id, `Sector grant by ${actor.id}`);
          added.push(role);
        }
      } catch (error) {
        const remaining = [];
        for (const role of added.reverse()) {
          try { await target.roles.remove(role.id, `Rollback failed sector grant by ${actor.id}`); }
          catch { remaining.push(role.id); }
        }
        logger.error('فشل إعطاء رتب القطاع', { guildId: guild.id, actorId: actor.id, targetId: target.id, code: error.code });
        throw new AppError(remaining.length
          ? `تعذر إكمال العملية. الرتب التالية أضيفت ولم يمكن التراجع عنها: ${remaining.map(id => `<@&${id}>`).join(' ')}. راجعها يدويًا.`
          : 'تعذر إعطاء الرتب؛ تم التراجع عن الرتب المضافة. راجع صلاحيات البوت وترتيب رتبته.');
      }
      logger.info('إعطاء رتب قطاع', { guildId: guild.id, actorId: actor.id, targetId: target.id, roleIds: missing.map(r => r.id) });
      await interaction.editReply({ content: `✅ تم إعطاء <@${target.id}> الرتب: ${missing.map(r => `<@&${r.id}>`).join(' ')}`, allowedMentions: { parse: [] } });
    });
  }
  return { registerGuild, handle };
}
