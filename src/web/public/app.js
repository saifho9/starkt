/* لوحة عربية بلا مكتبات خارجية. القيم القادمة من ديسكورد توضع كنصوص فقط. */
const $ = id => document.getElementById(id);
const state = { guildId: '', panels: [], resources: { channels: [], categories: [], roles: [] }, current: null, dirty: false, busy: 0, generation: 0, tickets: [], tab: 'panels', poll: null };
const fields = ['panelName', 'channelId', 'ticketCategoryId', 'panelContent', 'embedTitle', 'embedDescription', 'embedImageUrl', 'embedColor', 'selectPlaceholder', 'ticketMessage', 'claimLogChannelId', 'closeLogChannelId'];
let staffPicker;
let editingTicket = null;
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function notify(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
}
function showLogin() { $('app').hidden = true; $('loginScreen').hidden = false; }
async function api(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !url.endsWith('/login')) showLogin();
    throw new Error(data.message || 'تعذر إتمام الطلب. أعد المحاولة.');
  }
  return data;
}
const guildPath = (part = '', guildId = state.guildId) => {
  if (!guildId) throw new Error('اختر سيرفرًا أولًا.');
  return `/api/guilds/${guildId}${part}`;
};
function setBusy(value) {
  state.busy += value ? 1 : -1;
  const disabled = state.busy > 0;
  document.querySelectorAll('[data-lock]').forEach(button => { button.disabled = disabled; });
  $('panelFields').disabled = disabled;
  $('panelList').querySelectorAll('button').forEach(b => { b.disabled = disabled; });
}
async function action(fn) {
  setBusy(true);
  try { return await fn(); }
  catch (error) { notify(error.message, true); return null; }
  finally { setBusy(false); }
}
function markDirty() { state.dirty = true; }
function canLeave() { return !state.dirty || confirm('توجد تعديلات لم تُحفظ. هل تريد تركها؟'); }
function populateSelect(select, list, emptyText, selected = '') {
  select.replaceChildren();
  if (emptyText !== null) select.add(new Option(emptyText, ''));
  list.forEach(item => select.add(new Option(item.name, item.id)));
  if (selected && !list.some(item => item.id === selected)) select.add(new Option(`غير موجود حاليًا (${selected})`, selected));
  if (selected || emptyText !== null) select.value = selected;
}
function roleName(id) { return state.resources.roles.find(r => r.id === id)?.name || `رتبة غير موجودة (${id})`; }
function channelName(id) { return state.resources.channels.find(c => c.id === id)?.name || id || 'قناة غير محددة'; }
function createRolePicker(ids = []) {
  const selected = new Set(ids);
  const root = element('div', 'role-picker');
  const row = element('div', 'picker-row');
  const select = element('select'); select.setAttribute('aria-label', 'اختر رتبة الطاقم لإضافتها');
  populateSelect(select, state.resources.roles, 'اختر رتبة لإضافتها');
  const add = element('button', 'secondary', '+ إضافة'); add.type = 'button';
  const chips = element('div', 'chips');
  function render() {
    chips.replaceChildren();
    for (const id of selected) {
      const chip = element('span', 'chip'); chip.append(element('span', '', roleName(id)));
      const remove = element('button', '', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `إزالة ${roleName(id)}`);
      remove.onclick = () => { selected.delete(id); render(); markDirty(); };
      chip.append(remove); chips.append(chip);
    }
  }
  add.onclick = () => { if (select.value) { selected.add(select.value); select.value = ''; render(); markDirty(); } };
  row.append(select, add); root.append(row, chips); render();
  return { root, values: () => [...selected] };
}
function updateMenuCount() { $('menuCount').textContent = `${$('menuOptions').children.length}/25`; }
function optionData(wrapper) {
  const picker = wrapper._picker;
  return {
    value: wrapper.dataset.value,
    label: wrapper.querySelector('.menu-label').value.trim(),
    description: wrapper.querySelector('.menu-description').value.trim(),
    ...(wrapper.querySelector('.option-category').value ? { ticketCategoryId: wrapper.querySelector('.option-category').value } : {}),
    ...(wrapper.querySelector('.option-own-staff').checked ? { staffRoleIds: picker.values() } : {})
  };
}
function addMenuOption(option = {}) {
  if ($('menuOptions').children.length >= 25) { notify('الحد الأقصى 25 خيارًا.', true); return; }
  const wrapper = element('div', 'menu-item');
  wrapper.dataset.value = option.value || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `option_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  // القالب ثابت؛ البيانات لا تُدمج في HTML.
  wrapper.innerHTML = '<div class="section-title"><h3>خيار فتح تذكرة</h3><div class="option-actions"><button class="up ghost" type="button" aria-label="نقل الخيار لأعلى">↑</button><button class="down ghost" type="button" aria-label="نقل الخيار لأسفل">↓</button><button class="duplicate secondary" type="button">نسخ</button><button class="remove danger" type="button">حذف</button></div></div><div class="form-grid"><div><label>عنوان الخيار</label><input class="menu-label" maxlength="100" required /></div><div><label>الوصف المختصر</label><input class="menu-description" maxlength="100" /></div></div><label>تصنيف تذاكر هذا الخيار</label><select class="option-category"></select><details><summary>طاقم خاص لهذا الخيار</summary><label class="check-label"><input class="option-own-staff" type="checkbox" /> استخدام طاقم مختلف عن الطاقم الافتراضي</label><div class="option-picker" hidden></div></details>';
  wrapper.querySelector('.menu-label').value = option.label || '';
  wrapper.querySelector('.menu-description').value = option.description || '';
  populateSelect(wrapper.querySelector('.option-category'), state.resources.categories, 'استخدام التصنيف الافتراضي للوحة', option.ticketCategoryId || '');
  const own = wrapper.querySelector('.option-own-staff');
  own.checked = Array.isArray(option.staffRoleIds);
  const picker = createRolePicker(option.staffRoleIds || []); wrapper._picker = picker;
  const pickerRoot = wrapper.querySelector('.option-picker'); pickerRoot.append(picker.root); pickerRoot.hidden = !own.checked;
  own.onchange = () => { pickerRoot.hidden = !own.checked; markDirty(); };
  wrapper.querySelector('.remove').onclick = () => { wrapper.remove(); updateMenuCount(); markDirty(); };
  wrapper.querySelector('.up').onclick = () => { if (wrapper.previousElementSibling) wrapper.parentElement.insertBefore(wrapper, wrapper.previousElementSibling); markDirty(); };
  wrapper.querySelector('.down').onclick = () => { if (wrapper.nextElementSibling) wrapper.parentElement.insertBefore(wrapper.nextElementSibling, wrapper); markDirty(); };
  wrapper.querySelector('.duplicate').onclick = () => { const data = optionData(wrapper); delete data.value; addMenuOption(data); markDirty(); };
  $('menuOptions').append(wrapper); updateMenuCount();
}
function fillForm(panel = null) {
  state.current = panel;
  const p = panel || { embedTitle: 'الدعم الفني', embedDescription: 'اختر نوع التذكرة وسيقوم الفريق بمساعدتك.', embedColor: 0x3b82f6, menuOptions: [{ label: 'طلب دعم' }] };
  $('panelName').value = p.name || p.embedTitle || '';
  for (const id of ['panelContent', 'embedTitle', 'embedDescription', 'embedImageUrl', 'selectPlaceholder', 'ticketMessage']) $(id).value = p[id] || '';
  $('embedColor').value = `#${(p.embedColor ?? 0x3b82f6).toString(16).padStart(6, '0')}`;
  populateSelect($('channelId'), state.resources.channels, 'اختر قناة رسالة اللوحة', p.channelId || '');
  populateSelect($('ticketCategoryId'), state.resources.categories, 'بدون تصنيف', p.ticketCategoryId || '');
  for (const id of ['claimLogChannelId', 'closeLogChannelId']) populateSelect($(id), state.resources.channels, 'بدون سجل', p[id] || '');
  staffPicker = createRolePicker(p.staffRoleIds || []); $('staffPicker').replaceChildren(staffPicker.root);
  $('menuOptions').replaceChildren(); (p.menuOptions || []).forEach(addMenuOption);
  $('editorTitle').textContent = panel ? p.name || p.embedTitle : 'لوحة جديدة';
  $('recoveryWarning').hidden = !p.needsReview; $('recoveryNote').textContent = p.recoveryNote || ''; $('confirmRecovery').checked = false;
  $('panelDiscordLink').hidden = !p.messageId;
  if (p.messageId) $('panelDiscordLink').href = `https://discord.com/channels/${state.guildId}/${p.channelId}/${p.messageId}`;
  state.dirty = false; renderPanels();
}
function renderPanels() {
  const query = $('panelSearch').value.trim().toLowerCase();
  $('panelCount').textContent = state.panels.length;
  $('panelList').replaceChildren();
  const panels = state.panels.filter(p => `${p.name || ''} ${p.embedTitle} ${channelName(p.channelId)}`.toLowerCase().includes(query));
  if (!panels.length) $('panelList').append(element('p', 'empty', state.panels.length ? 'لا توجد نتائج مطابقة.' : 'لا توجد لوحات محفوظة بعد. سيظهر هنا أيضًا ما يتم استرجاعه من الرسائل القديمة.'));
  for (const p of panels) {
    const button = element('button', `panel-item${state.current?._id === p._id ? ' active' : ''}`);
    button.type = 'button'; button.disabled = state.busy > 0;
    button.append(element('span', 'title', p.name || p.embedTitle), element('span', 'meta', `# ${channelName(p.channelId)} · ${p.menuOptions?.length || 0} خيارات`));
    const status = p.needsReview ? 'تحتاج مراجعة' : p.recoveredFromMessageId ? 'لوحة مسترجعة' : p.messageId ? 'منشورة' : 'مسودة';
    button.append(element('span', `badge${p.needsReview ? ' review' : ''}`, status));
    button.onclick = () => { if (canLeave()) action(() => selectPanel(p._id)); };
    $('panelList').append(button);
  }
}
async function reloadPanels() {
  const guildId = state.guildId;
  const panels = await api(guildPath('/panels', guildId));
  if (guildId !== state.guildId) return;
  state.panels = panels; renderPanels();
}
async function selectPanel(id) {
  const guildId = state.guildId;
  const p = await api(guildPath(`/panels/${id}`, guildId));
  if (guildId === state.guildId) fillForm(p);
}
function collectPanel() {
  if (!$('panelForm').reportValidity()) throw new Error('أكمل الحقول المطلوبة في اللوحة.');
  const menuOptions = [...$('menuOptions').children].map(optionData);
  if (!menuOptions.length) throw new Error('أضف خيارًا واحدًا على الأقل.');
  const data = { name: $('panelName').value.trim(), staffRoleIds: staffPicker.values(), menuOptions, confirmRecovery: $('confirmRecovery').checked };
  for (const id of fields.filter(id => id !== 'panelName')) data[id] = $(id).value.trim();
  if (state.current?.updatedAt) data.expectedUpdatedAt = state.current.updatedAt;
  return data;
}
async function savePanel(publish = false) {
  // اجمع البيانات قبل تعطيل حقول النموذج كي يبقى تحقق المتصفح فعالًا.
  const data = collectPanel();
  const guildId = state.guildId;
  const id = state.current?._id;
  await action(async () => {
    let panel = await api(guildPath(`/panels${id ? `/${id}` : ''}`, guildId), { method: id ? 'PUT' : 'POST', body: data });
    if (guildId !== state.guildId) return;
    // الحفظ الناجح يُعرض فورًا حتى إن فشل النشر بعده، فلا تنشأ نسخة ثانية عند المحاولة.
    fillForm(panel); await reloadPanels();
    if (publish) { panel = await api(guildPath(`/panels/${panel._id}/publish`, guildId), { method: 'POST' }); fillForm(panel); await reloadPanels(); }
    notify(publish ? 'تم حفظ اللوحة ونشرها في ديسكورد. تم تحديث رسالتها الحالية إذا كانت موجودة.' : 'تم حفظ إعدادات هذه اللوحة. اضغط «حفظ ونشر» لتطبيقها على رسالة ديسكورد.');
  });
}

function renderTickets() {
  const query = $('ticketSearch').value.trim().toLowerCase();
  const rows = state.tickets.filter(t => `${t.name} ${t.categoryName} ${t.ownerId} ${t.selectedLabel}`.toLowerCase().includes(query));
  const table = createTable(['التذكرة', 'التصنيف', 'صاحب التذكرة', 'الحالة', 'الإجراءات']);
  for (const t of rows) {
    const tr = element('tr');
    const name = element('td'); name.append(element('strong', '', t.name)); name.append(element('div', 'muted', t.selectedLabel || (t.legacy ? 'تذكرة قديمة' : '')));
    tr.append(name, element('td', '', t.categoryName), element('td', '', t.ownerId || 'غير معروف'), element('td', '', t.claimedBy ? 'تم الاستلام' : 'مفتوحة'));
    const actions = element('td'); const group = element('div', 'actions');
    const link = element('a', 'button ghost', 'فتح ↗'); link.href = t.url; link.target = '_blank'; link.rel = 'noopener';
    const edit = element('button', 'secondary small', 'تعديل'); edit.onclick = () => openTicketEditor(t);
    group.append(link, edit); actions.append(group); tr.append(actions); table.tbody.append(tr);
  }
  $('ticketsTable').replaceChildren(table.root);
  if (!rows.length) $('ticketsTable').append(element('p', 'empty', 'لا توجد تذاكر مفتوحة مطابقة.'));
}
function createTable(headers) {
  const root = element('table'), thead = element('thead'), tr = element('tr'), tbody = element('tbody');
  headers.forEach(name => tr.append(element('th', '', name))); thead.append(tr); root.append(thead, tbody);
  return { root, tbody };
}
async function loadTickets() {
  const guildId = state.guildId, data = await api(guildPath('/tickets', guildId));
  if (guildId !== state.guildId) return;
  state.tickets = data; renderTickets();
}
function openTicketEditor(ticket) {
  editingTicket = { ...ticket, guildId: state.guildId };
  $('ticketEditName').value = ticket.name;
  populateSelect($('ticketEditCategory'), state.resources.categories, 'بدون تصنيف', ticket.categoryId);
  $('ticketDialog').showModal();
}
async function loadStats() {
  const guildId = state.guildId, data = await api(guildPath('/stats/top?limit=50', guildId));
  if (guildId !== state.guildId) return;
  const table = createTable(['العضو', 'المعرّف', 'التذاكر المستلمة']);
  for (const row of data.filter(d => d.claimedCount > 0)) {
    const tr = element('tr'); tr.append(element('td', '', row.displayName), element('td', '', row.userId), element('td', '', String(row.claimedCount))); table.tbody.append(tr);
  }
  $('statsTable').replaceChildren(table.root);
  if (!table.tbody.children.length) $('statsTable').append(element('p', 'empty', 'لا توجد عمليات استلام مسجلة بعد.'));
}
async function loadSectors() {
  const guildId = state.guildId, sectors = await api(guildPath('/sectors', guildId));
  if (guildId !== state.guildId) return;
  $('sectorsList').replaceChildren();
  for (const sector of sectors) {
    const card = element('article', 'card sector-card'); card.append(element('h2', '', sector.name));
    card.append(element('p', 'hint', `مسؤول إعطاء الرتب: ${roleName(sector.managerRoleId)}`));
    card.append(element('p', 'hint', `من ${roleName(sector.firstRoleId)} إلى ${roleName(sector.lastRoleId)}`));
    if (sector.error) card.append(element('p', 'error-text', sector.error));
    else {
      card.append(element('span', 'badge', `${sector.roles.length} رتبة داخل النطاق`));
      const list = element('div', 'role-list');
      for (const role of sector.roles) {
        const line = element('div', 'role-line', role.name);
        if (role.overlap) line.append(element('small', 'error-text', 'تداخل مع قطاع آخر: عدّل ترتيب الرتب قبل استخدام الأمر.'));
        else if (!role.editable) line.append(element('small', '', 'يجب رفع رتبة البوت فوق هذه الرتبة.'));
        list.append(line);
      }
      card.append(list);
    }
    $('sectorsList').append(card);
  }
}
async function discoveryStatus() {
  const guildId = state.guildId;
  if (!guildId) return;
  const status = await api(guildPath('/discover', guildId));
  if (guildId !== state.guildId) return;
  const note = status.errors || status.skipped ? ` · ${status.errors || 0} أخطاء قراءة، ${status.skipped || 0} قنوات غير متاحة` : '';
  $('discoveryStatus').textContent = status.state === 'running'
    ? `جارٍ فحص الرسائل القديمة… ${status.messages} رسالة · ${status.recovered} لوحة${note}`
    : status.state === 'complete' ? `اكتمل الفحص: ${status.recovered} رسالة لوحة، ${status.channels} قناة${note}`
    : status.state === 'failed' ? 'تعذر استكمال الفحص. راجع صلاحيات قراءة الرسائل ثم أعد المحاولة.' : 'يمكن فحص رسائل البوت القديمة لإظهار اللوحات المنشورة سابقًا.';
  $('discover').disabled = status.state === 'running' || state.busy > 0;
  if (status.state === 'running') {
    await reloadPanels();
    clearTimeout(state.poll); state.poll = setTimeout(() => discoveryStatus().catch(e => notify(e.message, true)), 2500);
  } else { await reloadPanels(); }
}
async function selectGuild() {
  const guildId = $('guildSelect').value;
  const generation = ++state.generation;
  clearTimeout(state.poll); state.guildId = guildId; state.panels = []; state.current = null; state.dirty = false;
  $('notice').hidden = true;
  if (!guildId) { notify('البوت ليس موجودًا في أي سيرفر حاليًا. أضفه إلى سيرفرك أولًا.', true); return; }
  const [resources, panels] = await Promise.all([api(guildPath('/resources', guildId)), api(guildPath('/panels', guildId))]);
  if (generation !== state.generation) return;
  state.resources = resources; state.panels = panels; fillForm(panels[0] || null);
  const status = await api(guildPath('/discover', guildId));
  if (status.state === 'idle') await api(guildPath('/discover', guildId), { method: 'POST' });
  await discoveryStatus();
  if (state.tab === 'tickets') await loadTickets();
  if (state.tab === 'stats') await loadStats();
  if (state.tab === 'sectors') await loadSectors();
}
async function initialize() {
  const session = await api('/api/auth/session');
  if (!session.authenticated) { showLogin(); return; }
  $('loginScreen').hidden = true; $('app').hidden = false;
  $('connectionStatus').textContent = session.ready ? '● البوت متصل' : 'جارٍ الاتصال';
  $('connectionStatus').classList.toggle('waiting', !session.ready);
  if (!session.ready) { notify('البوت يتصل بديسكورد وقاعدة البيانات…'); setTimeout(() => initialize().catch(e => notify(e.message, true)), 3000); return; }
  const guilds = await api('/api/guilds'); populateSelect($('guildSelect'), guilds, null);
  await action(selectGuild);
}
document.querySelectorAll('[data-tab]').forEach(button => {
  button.onclick = () => {
    state.tab = button.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
    document.querySelectorAll('.tab-view').forEach(view => { view.hidden = view.id !== `tab-${state.tab}`; });
    const load = { tickets: loadTickets, stats: loadStats, sectors: loadSectors }[state.tab];
    if (load && state.guildId) action(load);
  };
});
$('loginForm').onsubmit = async event => {
  event.preventDefault(); $('loginButton').disabled = true; $('loginError').textContent = '';
  try { await api('/api/auth/login', { method: 'POST', body: { password: $('password').value } }); $('password').value = ''; await initialize(); }
  catch (error) { $('loginError').textContent = error.message; }
  finally { $('loginButton').disabled = false; }
};
$('logout').onclick = async () => { if (canLeave()) { await action(async () => { await api('/api/auth/logout', { method: 'POST' }); clearTimeout(state.poll); showLogin(); }); } };
$('guildSelect').onchange = () => { if (!canLeave()) { $('guildSelect').value = state.guildId; return; } action(selectGuild); };
$('panelForm').oninput = markDirty; $('panelForm').onchange = markDirty;
$('panelForm').onsubmit = event => { event.preventDefault(); savePanel().catch(e => notify(e.message, true)); };
$('savePanel').onclick = () => savePanel().catch(e => notify(e.message, true));
$('publishPanel').onclick = () => savePanel(true).catch(e => notify(e.message, true));
$('newPanel').onclick = () => { if (canLeave()) fillForm(); };
$('reloadPanels').onclick = () => action(async () => { if (!canLeave()) return; await reloadPanels(); if (state.current) await selectPanel(state.current._id); });
$('panelSearch').oninput = renderPanels;
$('addMenuOption').onclick = () => { addMenuOption(); markDirty(); };
$('discover').onclick = () => action(async () => { await api(guildPath('/discover'), { method: 'POST' }); await discoveryStatus(); });
$('refreshTickets').onclick = () => action(loadTickets); $('ticketSearch').oninput = renderTickets;
$('refreshStats').onclick = () => action(loadStats); $('refreshSectors').onclick = () => action(loadSectors);
$('resetStats').onclick = () => {
  if (!confirm($('resetUserId').value.trim() ? 'هل تريد تصفير إحصائيات العضو المحدد؟' : 'هل تريد تصفير إحصائيات كل الطاقم؟')) return;
  action(async () => { await api(guildPath('/stats/reset'), { method: 'POST', body: { userId: $('resetUserId').value.trim() || undefined } }); await loadStats(); notify('تم تصفير الإحصائيات المطلوبة.'); });
};
$('cancelTicketEdit').onclick = () => $('ticketDialog').close();
$('ticketEditForm').onsubmit = event => {
  event.preventDefault(); if (!editingTicket) return;
  const ticket = editingTicket;
  const body = { name: $('ticketEditName').value, categoryId: $('ticketEditCategory').value };
  $('ticketDialog').close();
  action(async () => { await api(guildPath(`/tickets/${ticket.id}`, ticket.guildId), { method: 'PATCH', body }); await loadTickets(); notify('تم تعديل التذكرة مع الحفاظ على صلاحياتها.'); });
};
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
initialize().catch(error => { showLogin(); $('loginError').textContent = error.message; });
