import 'dotenv/config';
import { 
  Client, 
  Events, 
  GatewayIntentBits, 
  Partials, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags
} from 'discord.js';
import mongoose from 'mongoose';
import { createTicketService } from './src/services/ticketService.js';
import { startWebServer } from './src/web/server.js';
import { createPanelService } from './src/services/panelService.js';
import { createRoleService } from './src/services/roleService.js';
import { AppError } from './src/utils/errors.js';

const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // تم تفعيل هذا الخيار ليتمكن البوت من قراءة أمر !setup-rules
  ],
  partials: [Partials.Channel, Partials.Message]
});

async function bootstrap() {
  const { DISCORD_TOKEN, MONOG_URI, MONGO_URI } = process.env;
  const dbUri = MONGO_URI || MONOG_URI;
  
  if (!DISCORD_TOKEN) {
    throw new Error('DISCORD_TOKEN مفقود في ملف .env');
  }
  if (!dbUri) {
    throw new Error('MONGO_URI مفقود في ملف .env');
  }

  const panelService = createPanelService({ client, logger });
  const ticketService = createTicketService({ client, logger, panelService });
  const roleService = createRoleService({ client, logger });
  const server = await startWebServer({
    client, logger, ticketService, panelService,
    port: Number(process.env.PORT || 3000), host: process.env.HOST || '0.0.0.0',
    baseUrl: process.env.BASE_URL || null,
    isReady: () => client.isReady() && mongoose.connection.readyState === 1
  });
  await mongoose.connect(dbUri, { serverSelectionTimeoutMS: 30_000 });
  logger.info('متصل بقاعدة بيانات MongoDB');
  // إنشاء فهارس المجموعات الجديدة فقط؛ لا إسقاط ولا إعادة تسمية للمجموعات القديمة.
  const { PanelMessage } = await import('./src/models/panelMessage.js');
  const { Ticket } = await import('./src/models/ticket.js');
  const { TicketPanel } = await import('./src/models/ticketPanel.js');
  await Promise.all([PanelMessage.init(), Ticket.init(), TicketPanel.init()]);

  client.once(Events.ClientReady, async (c) => {
    logger.info(`تم تسجيل الدخول باسم ${c.user.tag}`);
    for (const guild of c.guilds.cache.values()) {
      try { await roleService.registerGuild(guild); }
      catch (error) { logger.error('تعذر تسجيل /give role. تأكد من دعوة البوت بنطاق applications.commands.', { guildId: guild.id, code: error.code }); }
      // الاسترجاع يعمل في الخلفية دون تعطيل الأوامر أو فتح التيكتات.
      panelService.startDiscovery(guild.id);
    }
  });
  client.on(Events.GuildCreate, guild => {
    roleService.registerGuild(guild).catch(error => logger.error('تعذر تسجيل أمر الرتب', { guildId: guild.id, code: error.code }));
    panelService.startDiscovery(guild.id);
  });
  client.on(Events.Error, error => logger.error('خطأ اتصال ديسكورد', { message: error.message, code: error.code }));

  // حدث قراءة أمر إرسال رسالة القوانين
  client.on(Events.MessageCreate, async (message) => {
    if (message.content === '!setup-rules') {
      // التأكد من أن الشخص الذي كتب الأمر لديه صلاحية الإدارة
      if (!message.inGuild() || !message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

      const embed = new EmbedBuilder()
        .setAuthor({ 
          name: 'شروط و أحكام مقاطعة ستارك' 
        })
        .setTitle('سياسة سيرفر مقاطعة ستارك')
        .setDescription(`**أولاً: سياسة السيرفر**
بمجرد دخولك لسيرفر مقاطعة ستارك، أنت توافق على الالتزام بما يلي:

• **الخيال مقابل الواقع:** جميع الأحداث والأسماء والأدوار داخل السيرفر خيالية تمامًا ولا تمت للواقع بصلة. لا يجوز تقليد أي سلوك في الحياة الواقعية. يجب أن يكون عمرك 16 سنة أو أكثر وأن تكون قادرًا على التمييز بين اللعبة والواقع.

• **تقمص الأدوار والمسؤولية الشخصية:** تقمصك دور طبيب أو مسعف لا يمنحك أي صفة حقيقية، وتقمصك لدور مجرم لا يجعلك مجرمًا في الواقع. يجب الفصل تمامًا بين شخصيتك في اللعبة وحياتك الواقعية.

• **غرض السيرفر:** تقديم تجربة ترفيهية في تمثيل الأدوار فقط، ولا يمثل أي دولة أو واقع حقيقي.

• **المواضيع المحظورة:** يمنع الحديث عن السياسة أو الدين، واستخدام أسماء شخصيات سياسية أو دينية، أو المساس برموز الدول والحكومات.

• **المسؤولية القانونية:** أنت تتحمل المسؤولية الكاملة عن أفعالك داخل السيرفر. الإدارة تُخلي مسؤوليتها عن أي تبعات قانونية. إذا كنت تحت السن القانوني، يجب أن يكون دخولك بموافقة ولي الأمر.

• **تحديث السياسة:** يحتفظ السيرفر بحق تحديث هذه السياسة، وينصح بمراجعتها بشكل دوري.

---

**ثانياً: شروط اللعب والتمثيل**

1. **الالتزام بالقواعد واحترام الجميع:** يجب احترام القوانين واللاعبين، واتباع إرشادات المراقبين والإداريين، والحفاظ على التمثيل الصحيح للأدوار.
2. **الحفاظ على نزاهة اللعب:** يمنع استخدام أي برامج غش أو أدوات خارجية لضمان تجربة عادلة للجميع.
3. **تعزيز بيئة الاحترام وحماية الخصوصية:** يمنع أي مضايقة أو إساءة لأي لاعب، خصوصًا عند التعامل مع اللاعبات.

---

**ثالثاً: شروط استخدام ديسكورد**

• التواصل مع الإدارة يكون عبر التكت أو القنوات الرسمية فقط، وليس برسائل خاصة لأي موضوع.
• يمنع نشر روابط أو الترويج لسيرفرات أخرى في القنوات العامة أو الخاصة.
• يمنع السب والقذف والشتم في جميع القنوات.
• يمنع الحديث عن السياسة أو الدين.
• يمنع تكوين تجمعات للاعبين أو الوظائف خارج ديسكورد الرسمي للسيرفر.`)
        .setColor('Blue');

      const button = new ButtonBuilder()
        .setCustomId('accept_rules_button')
        .setLabel('موافق على الشروط')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅');

      const row = new ActionRowBuilder().addComponents(button);

      try {
        await message.channel.send({ embeds: [embed], components: [row] });
        await message.delete().catch(() => {}); // حذف رسالة الأمر لتنظيف الروم
      } catch (error) {
        logger.error('خطأ في إرسال رسالة القوانين. تأكد من إعطاء البوت صلاحية Send Messages و Embed Links في الروم:', error);
      }
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'give' && interaction.options.getSubcommand() === 'role') {
        await roleService.handle(interaction);
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket-panel:')) {
        await ticketService.handleSelectInteraction(interaction);
      } else if (interaction.isButton()) {
        
        // --- نظام الموافقة على القوانين وإعطاء الرتبة ---
        if (interaction.customId === 'accept_rules_button') {
          if (!interaction.inGuild()) return;
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const roleId = '1378729804651565206';
          const role = await interaction.guild.roles.fetch(roleId);
          const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });

          if (!role) {
            return interaction.editReply({ content: 'حدث خطأ: الرتبة غير موجودة، يرجى إبلاغ الإدارة.' });
          }

          if (member.roles.cache.has(roleId)) {
            return interaction.editReply({ content: 'أنت تمتلك هذه الرتبة بالفعل وتم فتح الرومات لك!' });
          }

          try {
            await member.roles.add(role);
            return interaction.editReply({ content: '✅ تم الموافقة على الشروط وإعطائك الرتبة بنجاح!' });
          } catch (roleError) {
            logger.error('خطأ في إعطاء الرتبة:', roleError);
            return interaction.editReply({ content: '❌ البوت لا يمتلك صلاحية إعطاء هذه الرتبة، تأكد أن رتبة البوت أعلى من الرتبة المراد إعطاؤها.' });
          }
        }
        // ---------------------------------------------

        // إذا لم يكن الزر هو زر القوانين، سيتم توجيهه لنظام التيكت الطبيعي
        await ticketService.handleTicketButton(interaction);
      }
    } catch (error) {
      // تفاعل انتهت صلاحيته أو سبق أن استجابت له نسخة أخرى أثناء إعادة النشر.
      if (error.code === 10062 || error.code === 40060) return;
      if (!(error instanceof AppError)) logger.error('فشل التعامل مع التفاعل', { message: error.message, code: error.code });
      const content = error instanceof AppError ? error.message : 'حدث خطأ أثناء معالجة الطلب. راجع اتصال البوت وصلاحياته ثم حاول مرة أخرى.';
      try {
        if (interaction.deferred) await interaction.editReply({ content, allowedMentions: { parse: [] } });
        else if (interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } catch (replyError) { logger.error('تعذر الرد على التفاعل', { code: replyError.code }); }
    }
  });

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info(`جارٍ إيقاف البوت (${signal})`);
    server.close();
    client.destroy();
    await mongoose.disconnect();
    process.exit(0);
  }
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(() => process.exit(1)));
  process.once('SIGINT', () => shutdown('SIGINT').catch(() => process.exit(1)));
  await client.login(DISCORD_TOKEN);
}

bootstrap().catch((err) => {
  logger.error('فشل تشغيل البوت', { name: err.name, code: err.code, message: err.code === 'TokenInvalid' ? 'توكن ديسكورد غير صالح.' : err.name?.startsWith('Mongo') ? 'تعذر الاتصال بقاعدة MongoDB. تحقق من المتغيرات والسماح بالاتصال من Railway.' : err.message });
  process.exit(1);
});
