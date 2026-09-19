import 'dotenv/config';
import { Client, Events, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
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
    GatewayIntentBits.MessageContent, // تم إضافة هذا السطر ليتمكن البوت من قراءة أمر !setup-rules
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

  // حدث جديد لقراءة أمر إرسال رسالة القوانين
  client.on(Events.MessageCreate, async (message) => {
    if (message.content === '!setup-rules') {
      if (!message.member.permissions.has('Administrator')) return;

      const embed = new EmbedBuilder()
        .setTitle('📜 قوانين السيرفر')
        .setDescription('يرجى قراءة القوانين بتمعن. الضغط على الزر بالأسفل يعني موافقتك التامة على الشروط، وبناءً عليه سيتم فتح الرومات لك.')
        .setColor('Blue');

      const button = new ButtonBuilder()
        .setCustomId('accept_rules_button')
        .setLabel('موافق على الشروط')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅');

      const row = new ActionRowBuilder().addComponents(button);

      await message.channel.send({ embeds: [embed], components: [row] });
      await message.delete().catch(() => {}); 
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

          await interaction.member.roles.add(role);
          return interaction.reply({ content: '✅ تم الموافقة على الشروط وإعطائك الرتبة بنجاح!', ephemeral: true });
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
