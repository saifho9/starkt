// اختبارات تكامل اختيارية على MongoDB محلي معزول، ولا تقرأ MONGO_URI الخاص بالبوت.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { TicketPanel } from '../src/models/ticketPanel.js';
import { PanelMessage } from '../src/models/panelMessage.js';
import { Ticket } from '../src/models/ticket.js';
import { StaffStats } from '../src/models/staffStats.js';
import { createPanelService } from '../src/services/panelService.js';
import { createTicketService, ticketButtons } from '../src/services/ticketService.js';
import { SECTORS } from '../src/config/sectors.js';
import { makeDiscord, panelData, interaction, member, GUILD, USER, BOT, PANEL_ID, POLICE_CATEGORY, MECHANIC_CATEGORY, PANEL_CHANNEL, SECOND_CHANNEL, nextId, logger } from './helpers.js';

const uri = process.env.TEST_MONGO_URI;
test('MongoDB integration: isolated panel routing and legacy recovery', { skip: !uri }, async t => {
  assert.match(uri, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//, 'Only a local disposable test MongoDB is accepted');
  await mongoose.connect(uri, { dbName: `stark_bot_qa_${Date.now()}` });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await Promise.all([TicketPanel.init(), PanelMessage.init(), Ticket.init(), StaffStats.init()]);
  const setup = async () => {
    await Promise.all([TicketPanel.deleteMany({}), PanelMessage.deleteMany({}), Ticket.deleteMany({}), StaffStats.deleteMany({})]);
    const d = makeDiscord();
    const panels = createPanelService({ client: d.client, logger });
    const tickets = createTicketService({ client: d.client, logger, panelService: panels });
    return { d, panels, tickets };
  };
  await t.test('create two saved panels, edit one, preserve the other and partial fields', async () => {
    const { panels } = await setup();
    const police = await panels.savePanel(GUILD, panelData({ panelContent: 'نص محفوظ' }));
    const mechanic = await panels.savePanel(GUILD, panelData({ name: 'الميكانيكي', channelId: SECOND_CHANNEL, ticketCategoryId: MECHANIC_CATEGORY }));
    assert.equal((await panels.listPanels(GUILD)).length, 2);
    await panels.savePanel(GUILD, { name: 'شرطة محدّثة', expectedUpdatedAt: police.updatedAt }, String(police._id));
    const untouched = await panels.getPanel(GUILD, String(mechanic._id)); assert.equal(untouched.ticketCategoryId, MECHANIC_CATEGORY);
    assert.equal((await panels.getPanel(GUILD, String(police._id))).panelContent, 'نص محفوظ');
  });
  await t.test('optimistic update rejects stale editor without overwriting newer data', async () => {
    const { panels } = await setup(); const p = await panels.savePanel(GUILD, panelData());
    await panels.savePanel(GUILD, { name: 'نسخة أحدث', expectedUpdatedAt: p.updatedAt }, String(p._id));
    await assert.rejects(panels.savePanel(GUILD, { name: 'نسخة قديمة', expectedUpdatedAt: p.updatedAt }, String(p._id)), /جلسة أخرى/);
    assert.equal((await panels.getPanel(GUILD, String(p._id))).name, 'نسخة أحدث');
  });
  await t.test('publish edits the same message and saves a stable snapshot', async () => {
    const { d, panels } = await setup(); const p = await panels.savePanel(GUILD, panelData());
    const first = await panels.postPanel(GUILD, String(p._id)); await panels.postPanel(GUILD, String(p._id));
    assert.equal(d.channels.get(PANEL_CHANNEL)._messages.size, 1); assert.equal(await PanelMessage.countDocuments({}), 1);
    await panels.savePanel(GUILD, { ticketCategoryId: MECHANIC_CATEGORY }, String(p._id));
    const message = d.channels.get(PANEL_CHANNEL)._messages.get(first.messageId);
    const published = await panels.resolveMessage(message, d.guild); assert.equal(published.ticketCategoryId, POLICE_CATEGORY);
  });
  await t.test('historical police message sharing overwritten mechanic ID gets its own recovered panel', async () => {
    const { d, panels, tickets } = await setup();
    const current = await TicketPanel.create({ _id: PANEL_ID, guildId: GUILD, ...panelData({ name: 'الميكانيكي', channelId: SECOND_CHANNEL, ticketCategoryId: MECHANIC_CATEGORY, embedTitle: 'الميكانيكي', embedDescription: 'دعم ميكانيكي', menuOptions: [{ label: 'دعم ميكانيكي', value: 'mechanic' }], staffRoleIds: [SECTORS[2].managerRoleId] }), embedColor: 0x4388ff });
    const mechanicMessage = d.message(d.channels.get(SECOND_CHANNEL), panels.buildMessage(current)); current.messageId = mechanicMessage.id; await current.save();
    const policeMessage = d.message(d.channels.get(PANEL_CHANNEL), panels.buildMessage({ ...current.toObject(), ...panelData(), _id: PANEL_ID, embedColor: 0x4388ff }));
    const oldChannel = d.textChannel(nextId(), { parent: POLICE_CATEGORY, topic: `ticket:1378729600000000999:panel:${PANEL_ID}`, permissionOverwrites: [{ id: SECTORS[0].managerRoleId, type: 0, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] });
    d.channels.set(oldChannel.id, oldChannel);
    const opening = d.message(oldChannel, { embeds: [{ description: 'الترحيب القديم', fields: [{ name: 'صاحب التذكرة', value: '<@1378729600000000999>' }, { name: 'القائمة المختارة', value: 'دعم الشرطة' }] }] }); oldChannel._pins.push(opening);
    const recovered = await panels.resolveMessage(policeMessage, d.guild);
    assert.notEqual(String(recovered._id), PANEL_ID); assert.equal(recovered.needsReview, false); assert.equal(recovered.menuOptions[0].ticketCategoryId, POLICE_CATEGORY);
    assert.equal((await panels.getPanel(GUILD, PANEL_ID)).ticketCategoryId, MECHANIC_CATEGORY);
    await tickets.handleSelectInteraction(interaction(d, policeMessage)); assert.equal(d.created.at(-1).parent, POLICE_CATEGORY);
    assert.ok(d.created.at(-1).permissionOverwrites.some(o => o.id === SECTORS[0].managerRoleId)); assert.ok(!d.created.at(-1).permissionOverwrites.some(o => o.id === SECTORS[2].managerRoleId));
    assert.equal(d.deleted.length, 0); assert.ok(d.channels.has(oldChannel.id)); assert.equal((await panels.listPanels(GUILD)).length, 2);
    assert.equal(String((await panels.resolveMessage(policeMessage, d.guild))._id), String(recovered._id));
  });
  await t.test('unrecoverable historical route is visible and blocked instead of guessing', async () => {
    const { d, panels, tickets } = await setup();
    const message = d.message(d.channels.get(PANEL_CHANNEL), panels.buildMessage({ ...panelData(), _id: PANEL_ID, embedColor: 0x4388ff }));
    const recovered = await panels.resolveMessage(message, d.guild); assert.equal(recovered.needsReview, true);
    await assert.rejects(tickets.handleSelectInteraction(interaction(d, message)), /مراجعة وجهتها/); assert.equal(d.created.length, 0); assert.equal(d.deleted.length, 0);
    const reviewed = await panels.savePanel(GUILD, { ticketCategoryId: POLICE_CATEGORY, staffRoleIds: [SECTORS[0].managerRoleId], confirmRecovery: true }, String(recovered._id)); assert.equal(reviewed.needsReview, false);
    await panels.postPanel(GUILD, String(recovered._id)); await tickets.handleSelectInteraction(interaction(d, d.channels.get(PANEL_CHANNEL)._messages.get(message.id))); assert.equal(d.created.length, 1);
  });
  await t.test('each option opens in its own category with its own staff roles', async () => {
    const { d, panels, tickets } = await setup();
    const p = await panels.savePanel(GUILD, panelData({ menuOptions: [panelData().menuOptions[0], { label: 'دعم ميكانيكي', value: 'mechanic', ticketCategoryId: MECHANIC_CATEGORY, staffRoleIds: [SECTORS[2].managerRoleId] }] }));
    const pub = await panels.postPanel(GUILD, String(p._id)); const message = d.channels.get(PANEL_CHANNEL)._messages.get(pub.messageId);
    await tickets.handleSelectInteraction(interaction(d, message, 'mechanic')); await tickets.handleSelectInteraction(interaction(d, message));
    assert.equal(d.created[0].parent, MECHANIC_CATEGORY); assert.equal(d.created[1].parent, POLICE_CATEGORY);
    assert.deepEqual(d.created[0].permissionOverwrites.filter(o => [SECTORS[0].managerRoleId, SECTORS[2].managerRoleId].includes(o.id)).map(o => o.id), [SECTORS[2].managerRoleId]);
  });
  await t.test('concurrent presses create one ticket, including across two service instances', async () => {
    const { d, panels, tickets } = await setup(); const other = createTicketService({ client: d.client, logger, panelService: panels });
    const p = await panels.savePanel(GUILD, panelData()); const pub = await panels.postPanel(GUILD, String(p._id)); const message = d.channels.get(PANEL_CHANNEL)._messages.get(pub.messageId);
    await Promise.all([tickets.handleSelectInteraction(interaction(d, message)), other.handleSelectInteraction(interaction(d, message))]);
    assert.equal(d.created.length, 1); assert.equal(await Ticket.countDocuments({ state: 'open' }), 1);
    const record = await Ticket.findOne({ state: 'open' }); assert.match(d.created[0].topic, /^ticket:/); assert.equal(record.channelId, d.created[0].channel.id);
  });
  await t.test('unknown selection, wrong guild and forged message author create nothing', async () => {
    const { d, panels, tickets } = await setup(); const p = await panels.savePanel(GUILD, panelData()); const pub = await panels.postPanel(GUILD, String(p._id)); const message = d.channels.get(PANEL_CHANNEL)._messages.get(pub.messageId);
    await assert.rejects(tickets.handleSelectInteraction(interaction(d, message, 'removed')), /لم يعد موجودًا/);
    await assert.rejects(panels.resolveMessage({ ...message, guildId: nextId() }, d.guild)); await assert.rejects(panels.resolveMessage({ ...message, author: { id: USER } }, d.guild)); assert.equal(d.created.length, 0);
  });
  await t.test('claim race increments stats once and unrelated users cannot claim', async () => {
    const { d, panels, tickets } = await setup(); const p = await panels.savePanel(GUILD, panelData()); const pub = await panels.postPanel(GUILD, String(p._id));
    await tickets.handleSelectInteraction(interaction(d, d.channels.get(PANEL_CHANNEL)._messages.get(pub.messageId)));
    const ch = d.created[0].channel, opening = ch._messages.first(), staffId = nextId(); d.members.set(staffId, member(staffId, [SECTORS[0].managerRoleId]));
    const claim = id => ({ ...interaction(d, opening, '', id), customId: 'ticket:claim' });
    await assert.rejects(tickets.handleTicketButton(claim(USER)), /مخصص لطاقم/);
    const other = createTicketService({ client: d.client, logger, panelService: panels });
    await Promise.all([tickets.handleTicketButton(claim(staffId)), other.handleTicketButton(claim(staffId))]);
    assert.equal((await StaffStats.findOne({ guildId: GUILD, userId: staffId })).claimedCount, 1); assert.equal((await Ticket.findOne({ channelId: ch.id })).claimedBy, staffId);
  });
  await t.test('open-ticket list includes unimported legacy channels and edits preserve overwrites', async () => {
    const { d, tickets } = await setup(); const ch = d.textChannel(nextId(), { parent: POLICE_CATEGORY, topic: `ticket:${USER}:panel:${PANEL_ID}`, permissionOverwrites: [{ id: SECTORS[0].managerRoleId, type: 0, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] }); d.channels.set(ch.id, ch);
    const listed = await tickets.listTickets(GUILD); assert.equal(listed.length, 1); assert.equal(listed[0].legacy, true);
    const overwrites = ch.permissionOverwrites.cache;
    await tickets.editTicket(GUILD, ch.id, { name: 'تيكت قديم', categoryId: MECHANIC_CATEGORY });
    assert.equal(ch.name, 'تيكت قديم'); assert.equal(ch.parentId, MECHANIC_CATEGORY); assert.equal(ch.permissionOverwrites.cache, overwrites); assert.equal(d.edited.at(-1).lockPermissions, false); assert.equal(d.deleted.length, 0);
  });
  await t.test('legacy claim button disabled remains claimed without changing old statistics', async () => {
    const { d, tickets } = await setup(); const ch = d.textChannel(nextId(), { parent: POLICE_CATEGORY, topic: `ticket:${USER}:panel:${PANEL_ID}`, permissionOverwrites: [{ id: SECTORS[0].managerRoleId, type: 0, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] }); d.channels.set(ch.id, ch);
    const open = d.message(ch, { embeds: [{ fields: [{ name: 'صاحب التذكرة', value: `<@${USER}>` }, { name: 'القائمة المختارة', value: 'دعم الشرطة' }] }], components: [ticketButtons(true)] }); ch._pins.push(open);
    const staffId = nextId(); d.members.set(staffId, member(staffId, [SECTORS[0].managerRoleId]));
    const press = { ...interaction(d, open, '', staffId), customId: 'ticket:claim' }; await tickets.handleTicketButton(press);
    assert.equal((await Ticket.findOne({ channelId: ch.id })).claimedBy, 'legacy-claimed'); assert.equal(await StaffStats.countDocuments({}), 0);
  });
  await t.test('close failure preserves the channel and allows retry', async () => {
    const { d, panels, tickets } = await setup(); const p = await panels.savePanel(GUILD, panelData()); const pub = await panels.postPanel(GUILD, String(p._id));
    await tickets.handleSelectInteraction(interaction(d, d.channels.get(PANEL_CHANNEL)._messages.get(pub.messageId)));
    const ch = d.created[0].channel, open = ch._messages.first(); ch.delete = async () => { throw Object.assign(new Error('forbidden'), { code: 50013 }); };
    const close = { ...interaction(d, open), customId: 'ticket:close' }; await assert.rejects(tickets.handleTicketButton(close), /تعذر إغلاق/);
    assert.equal((await Ticket.findOne({ channelId: ch.id })).state, 'open'); assert.ok(d.channels.has(ch.id));
  });
  await t.test('discovery scans old messages without editing or deleting Discord channels', async () => {
    const { d, panels } = await setup(); const p = await panels.savePanel(GUILD, panelData()); await panels.postPanel(GUILD, String(p._id));
    const before = d.edited.length; panels.startDiscovery(GUILD);
    for (let i = 0; i < 150 && panels.getDiscoveryStatus(GUILD).state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(panels.getDiscoveryStatus(GUILD).state, 'complete'); assert.equal(d.edited.length, before); assert.equal(d.deleted.length, 0);
  });
});
