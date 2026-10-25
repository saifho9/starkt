import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { SECTORS } from '../src/config/sectors.js';
import { parseRoleMentions, validateRoleGrant, getSectorRanges, createRoleService, giveCommand } from '../src/services/roleService.js';
import { BOT, GUILD, USER, makeDiscord, makeRoles, member, role, logger } from './helpers.js';

const police = SECTORS[0], civil = SECTORS[1], mechanic = SECTORS[2];
function options(extra = {}) {
  const roles = makeRoles(), actor = member(USER, [police.managerRoleId]), target = member('1378729600000000004'), bot = member(BOT);
  bot.permissions = new PermissionsBitField([PermissionFlagsBits.ManageRoles]); bot.roles.highest = role('1378729600000000003', 100);
  return { roles, actor, target, bot, requestedIds: [police.firstRoleId], ...extra };
}
test('parse multiple role mentions, raw IDs and duplicates', () => assert.deepEqual(parseRoleMentions(`<@&${police.firstRoleId}> <@&${police.lastRoleId}>، ${police.firstRoleId}`), [police.firstRoleId, police.lastRoleId]));
for (const text of ['', '@الشرطة', '<@1378729678675640321>', '<@&1378729678675640321> words', '<@&123>']) test(`reject malformed role input ${text}`, () => assert.throws(() => parseRoleMentions(text)));
test('reject more than 25 roles', () => assert.throws(() => parseRoleMentions(Array.from({ length: 26 }, (_, i) => String(1378729600000020000n + BigInt(i))).join(' '))));
test('slash command is /give role with a member and multiple mentions string', () => {
  const command = giveCommand.toJSON(); assert.equal(command.name, 'give'); assert.equal(command.options[0].name, 'role'); assert.deepEqual(command.options[0].options.map(o => o.type), [6, 3]);
});
for (const sector of SECTORS) test(`${sector.name}: allow both boundaries and a middle role`, () => {
  const request = options({ actor: member(USER, [sector.managerRoleId]), requestedIds: [sector.firstRoleId, sector.lastRoleId, `100000000000000000${SECTORS.indexOf(sector)}`] });
  assert.equal(validateRoleGrant(request).length, 3);
});
test('ranges use Discord hierarchy rather than numeric IDs', () => {
  const o = options({ requestedIds: ['1000000000000000000'] });
  assert.ok(BigInt(o.requestedIds[0]) < BigInt(police.firstRoleId)); assert.equal(validateRoleGrant(o).length, 1);
});
test('reversed endpoints still form an inclusive range', () => {
  const roles = makeRoles(); const ranges = getSectorRanges(roles, [{ ...police, firstRoleId: police.lastRoleId, lastRoleId: police.firstRoleId }]);
  assert.equal(ranges[0].lower.id, police.firstRoleId); assert.equal(ranges[0].upper.id, police.lastRoleId);
});
test('police cannot give mechanic or civil defense roles', () => { for (const id of [mechanic.firstRoleId, civil.lastRoleId]) assert.throws(() => validateRoleGrant(options({ requestedIds: [id] })), /ليست من رتب قطاعك/); });
test('a mixed allowed/foreign batch is rejected before any changes', () => assert.throws(() => validateRoleGrant(options({ requestedIds: [police.firstRoleId, mechanic.lastRoleId] }))));
test('administrators have no sector bypass', () => assert.throws(() => validateRoleGrant(options({ actor: member(USER, [], { permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]) }) })), /مخصص لمسؤولي/));
test('multiple explicit manager roles authorize their corresponding sectors', () => assert.equal(validateRoleGrant(options({ actor: member(USER, [police.managerRoleId, mechanic.managerRoleId]), requestedIds: [police.firstRoleId, mechanic.lastRoleId] })).length, 2));
test('broken authorized sector fails closed', () => { const o = options(); o.roles.delete(police.lastRoleId); assert.throws(() => validateRoleGrant(o), /غير موجودة/); });
test('managed, everyone, missing and roles above bot are rejected', () => {
  for (const kind of ['managed', 'everyone', 'missing', 'higher']) {
    const o = options(); if (kind === 'managed') o.roles.get(police.firstRoleId).managed = true;
    if (kind === 'everyone') o.requestedIds = [GUILD]; if (kind === 'missing') o.requestedIds = ['9999999999999999999'];
    if (kind === 'higher') o.bot.roles.highest.position = 1;
    assert.throws(() => validateRoleGrant(o));
  }
});
test('missing ManageRoles rejected', () => { const o = options(); o.bot.permissions = new PermissionsBitField(); assert.throws(() => validateRoleGrant(o), /إدارة الرتب/); });
test('overlapping sectors rejected even when caller leads both', () => {
  const sectors = [police, { ...civil, firstRoleId: police.firstRoleId }];
  assert.throws(() => validateRoleGrant(options({ sectors, requestedIds: [police.firstRoleId] })), /متداخلين/);
});
test('granting roles does not require target to have a lower highest role', () => assert.equal(validateRoleGrant(options({ target: member('1378729600000000004', [], { manageable: false }) })).length, 1));
test('grant service adds roles individually, preserves unrelated roles and skips existing', async () => {
  const d = makeDiscord(), target = member('1378729600000000004', ['9999999999999999999', police.firstRoleId]);
  d.members.set(USER, member(USER, [police.managerRoleId])); d.members.set(target.id, target);
  const service = createRoleService({ client: d.client, logger });
  const i = { inGuild: () => true, guild: d.guild, guildId: GUILD, user: { id: USER }, options: { getString: () => `<@&${police.firstRoleId}> <@&${police.lastRoleId}>`, getUser: () => target.user }, async deferReply() {}, async editReply(data) { this.result = data; } };
  await service.handle(i); assert.deepEqual(target.roles.calls, [['add', police.lastRoleId]]); assert.ok(target.roles.cache.has('9999999999999999999')); assert.match(i.result.content, /تم إعطاء/);
});
test('grant failure rolls back only newly added roles', async () => {
  const d = makeDiscord(), target = member('1378729600000000004', ['9999999999999999999']);
  d.members.set(USER, member(USER, [police.managerRoleId])); d.members.set(target.id, target);
  const original = target.roles.add;
  target.roles.add = async id => { if (id === police.lastRoleId) throw new Error('permission'); return original(id); };
  const service = createRoleService({ client: d.client, logger });
  const i = { inGuild: () => true, guild: d.guild, guildId: GUILD, user: { id: USER }, options: { getString: () => `<@&${police.firstRoleId}> <@&${police.lastRoleId}>`, getUser: () => target.user }, async deferReply() {}, async editReply() {} };
  await assert.rejects(service.handle(i), /تم التراجع/); assert.ok(target.roles.cache.has('9999999999999999999')); assert.ok(!target.roles.cache.has(police.firstRoleId));
});
