import 'dotenv/config';
import { 
  Client, 
  Events, 
  GatewayIntentBits, 
  Partials, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  EmbedBuilder 
} from 'discord.js';
import mongoose from 'mongoose';
import { createTicketService } from './src/services/ticketService.js';
import { startWebServer } from './src/web/server.js';

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

  await mongoose.connect(dbUri);
  logger.info('متصل بقاعدة بيانات MongoDB');

  const ticketService = createTicketService({ client, logger });

  client.once(Events.ClientReady, async (c) => {
    logger.info(`تم تسجيل الدخول باسم ${c.user.tag}`);
  });

  // حدث قراءة أمر إرسال رسالة القوانين
  client.on(Events.MessageCreate, async (message) => {
    if (message.content === '!setup-rules') {
      // التأكد من أن الشخص الذي كتب الأمر لديه صلاحية الإدارة
      if (!message.member.permissions.has('Administrator')) return;

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
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket-panel:')) {
        await ticketService.handleSelectInteraction(interaction);
      } else if (interaction.isButton()) {
        
        // --- نظام الموافقة على القوانين وإعطاء الرتبة ---
        if (interaction.customId === 'accept_rules_button') {
          const roleId = '1378729804651565206';
          const role = interaction.guild.roles.cache.get(roleId);

          if (!role) {
            return interaction.reply({ content: 'حدث خطأ: الرتبة غير موجودة، يرجى إبلاغ الإدارة.', ephemeral: true });
          }

          if (interaction.member.roles.cache.has(roleId)) {
            return interaction.reply({ content: 'أنت تمتلك هذه الرتبة بالفعل وتم فتح الرومات لك!', ephemeral: true });
          }

          try {
            await interaction.member.roles.add(role);
            return interaction.reply({ content: '✅ تم الموافقة على الشروط وإعطائك الرتبة بنجاح!', ephemeral: true });
          } catch (roleError) {
            logger.error('خطأ في إعطاء الرتبة:', roleError);
            return interaction.reply({ content: '❌ البوت لا يمتلك صلاحية إعطاء هذه الرتبة، تأكد أن رتبة البوت أعلى من الرتبة المراد إعطاؤها.', ephemeral: true });
          }
        }
        // ---------------------------------------------

        // إذا لم يكن الزر هو زر القوانين، سيتم توجيهه لنظام التيكت الطبيعي
        await ticketService.handleTicketButton(interaction);
      }
    } catch (error) {
      logger.error('فشل التعامل مع التفاعل', error);
      const content = 'حدث خطأ أثناء معالجة التفاعل. الرجاء إبلاغ الإدارة.';
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  });

  const port = process.env.PORT || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const baseUrl = process.env.BASE_URL || null;

  await Promise.all([
    startWebServer({ client, logger, ticketService, port, host, baseUrl }),
    client.login(DISCORD_TOKEN)
  ]);
}

bootstrap().catch((err) => {
  logger.error('فشل تشغيل البوت', err);
  process.exit(1);
});
