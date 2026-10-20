/* «Склад»: Вход, состояние синхронизации, навигация по вкладкам. */
/* ============================================================
   СИНХРОНИЗАЦИЯ: ВХОД И СОСТОЯНИЕ
   Приложение остаётся полностью рабочим без входа — тогда оно просто
   живёт на одном устройстве, как раньше. Вход включает обмен с сервером.
   ============================================================ */
function setSyncLine(text){
  const el = document.getElementById('syncLine');
  if(el) el.textContent = text;
  // цвет точки в шапке: идёт обмен / ошибка / без связи / всё в порядке
  const sub = document.getElementById('syncSub');
  if(sub) sub.dataset.state = /Обмен…|Проверяем/.test(text) ? 'busy'
    : /ошиб|не удал|не вышло/i.test(text) ? 'error'
    : /нет сети|без сети|офлайн|без входа|не выполнен|на устройстве/i.test(text) ? 'off' : 'ok';
}

function describeSync(state, detail){
  detail = detail || {};
  /* Очень коротко: строка в шапке делит место с числом товаров и не
     должна наезжать на кнопку настроек даже при «1 000 товаров». */
  if(state === 'syncing') return 'Обмен…';
  if(state === 'offline') return (detail.pending ? 'Нет сети · ' + detail.pending : 'Нет сети');
  if(state === 'signed-out') return 'Без входа';
  if(state === 'error') return 'Не удалось';
  if(state === 'idle'){
    if(detail.pending) return 'Ждут: ' + detail.pending;
    const t = detail.at ? new Date(detail.at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}) : '';
    return t ? ('Синхр. ' + t) : 'Синхр.';
  }
  return 'На устройстве';
}

/* Вызывается синхронизацией, когда с сервера прилетели чужие изменения. */
async function refreshAfterSync(){
  await refreshOpenProductStock();
  await renderStock();
  await renderHistory();
  await renderStats();
  await updateProductCountPill();
  const active = document.querySelector('main section.active');
  if(active && active.id === 'sec-finance'){ await renderFinance(currentFinancePeriod, null); renderFinSubTab(); }
  if(active && active.id === 'sec-balance') await renderBalance(currentBalancePeriod, null);
}

/* Пароль на телефоне набирают вслепую и часто ошибаются — даём посмотреть,
   что набрано. */
function togglePassVisible(){
  const input = document.getElementById('pinInput');
  const btn = document.getElementById('pinEye');
  const shown = input.type === 'text';
  input.type = shown ? 'password' : 'text';
  btn.classList.toggle('on', !shown);
  btn.setAttribute('aria-label', shown ? 'Показать пароль' : 'Скрыть пароль');
  btn.innerHTML = '<svg class="icon"><use href="#i-' + (shown ? 'eye' : 'eye-off') + '"/></svg>';
  input.focus();
}

/* Режимы окна входа: login — вход; register — новый отдельный склад;
   partner — вход партнёра по коду; change — смена пароля. */
const AUTH_TEXT = {
  login:    {title:'Вход в склад', hint:'Один вход на телефон, планшет и компьютер — данные едут между ними сами.',
             label:'E-mail или логин', ph:'например, ivan@mail.ru', btn:'Войти'},
  register: {title:'Новый склад', hint:'Укажите e-mail и придумайте пароль. Склад будет только ваш: ваши товары никто другой не увидит, чужие — вы.',
             label:'E-mail', ph:'ivan@mail.ru', btn:'Создать склад'},
  partner:  {title:'Вход для партнёра', hint:'Введите код приглашения от владельца, а логин и пароль придумайте свои.',
             label:'E-mail или логин', ph:'например, ivan@mail.ru', btn:'Войти'},
  change:   {title:'Новый пароль', hint:'Придумайте новый пароль, не короче 6 символов. На других устройствах нужно будет войти заново.',
             label:'', ph:'', btn:'Сохранить'}
};
function openPinModal(mode){
  mode = AUTH_TEXT[mode] ? mode : 'login';
  const bg = document.getElementById('pinModalBg');
  if(!bg) return;
  const isChange = (mode === 'change');
  const t = AUTH_TEXT[mode];
  document.getElementById('pinError').classList.remove('show');
  const pass = document.getElementById('pinInput');
  pass.value = '';
  pass.type = 'password';
  pass.setAttribute('autocomplete', isChange ? 'new-password' : 'current-password');
  document.getElementById('pinEye').classList.remove('on');
  document.getElementById('pinEye').innerHTML = '<svg class="icon"><use href="#i-eye"/></svg>';

  const loginInput = document.getElementById('loginInput');
  document.getElementById('loginField').style.display = isChange ? 'none' : 'block';
  loginInput.value = (mode === 'login' && window.Sync && Sync.lastLogin) ? Sync.lastLogin() : '';
  loginInput.placeholder = t.ph;
  loginInput.type = mode === 'register' ? 'email' : 'text';
  pass.setAttribute('autocomplete', (isChange || mode === 'register') ? 'new-password' : 'current-password');
  document.getElementById('loginLabel').textContent = t.label;
  document.getElementById('pinTitle').textContent = t.title;
  document.getElementById('pinHint').textContent = t.hint;
  document.getElementById('pinSubmitText').textContent = t.btn;
  const note = document.getElementById('authNote');
  if(note) note.style.display = mode === 'login' ? 'block' : 'none';
  // на основном входе — все пути; в остальных шагах только «Назад ко входу»
  document.querySelectorAll('.auth-skip').forEach(b=>{ b.style.display = mode === 'login' ? 'block' : 'none'; });
  document.getElementById('authBackBtn').hidden = (mode === 'login' || isChange);

  bg.dataset.emp = mode === 'partner' ? '1' : '0';
  const ef = document.getElementById('empFields'); if(ef) ef.hidden = mode !== 'partner';

  bg.dataset.mode = mode;
  bg.classList.add('show');
  setTimeout(()=>{
    const focusId = (isChange || document.getElementById('loginInput').value) ? 'pinInput' : 'loginInput';
    document.getElementById(focusId).focus();
  }, 60);
}
function closePinModal(){
  const bg = document.getElementById('pinModalBg');
  if(bg) bg.classList.remove('show');
}
function skipPin(){
  closePinModal();
  setSyncLine(describeSync('signed-out'));
}
function pinFail(message){
  const err = document.getElementById('pinError');
  err.textContent = message;
  err.classList.add('show');
  document.getElementById('pinSubmit').disabled = false;
}

async function submitPin(){
  const password = document.getElementById('pinInput').value || '';
  const login = (document.getElementById('loginInput').value || '').trim();
  const bg = document.getElementById('pinModalBg');
  const mode = bg ? bg.dataset.mode : 'login';

  if(password.length < 6){ pinFail('Пароль — не короче 6 символов'); return; }
  if(mode !== 'change' && !login){ pinFail('Укажите логин'); return; }
  document.getElementById('pinSubmit').disabled = true;

  if(mode === 'change'){
    const res = await Sync.changePassword(password);
    document.getElementById('pinSubmit').disabled = false;
    if(!res.ok){ pinFail(res.error); return; }
    closePinModal();
    toast('Пароль изменён. На других устройствах войдите заново');
    return;
  }

  /* Вход партнёра: своя учётная запись (логин+пароль) + присоединение по коду. */
  if(bg && bg.dataset.emp === '1'){
    const code = (document.getElementById('inviteCodeInput').value || '').trim();
    if(!code){ pinFail('Введите код приглашения'); return; }
    setSyncLine('Проверяем…');
    const si = await Sync.signIn(login, password, 'auto');
    if(!si.ok){ pinFail(si.error || 'Не удалось войти'); setSyncLine(describeSync('signed-out')); return; }
    const jr = await Sync.joinWorkspace(code, '');
    document.getElementById('pinSubmit').disabled = false;
    if(!jr.ok){ pinFail(jr.error || 'Не удалось присоединиться по коду'); return; }
    if(si.switched){ location.reload(); return; }   // данные прежнего аккаунта стёрты — начинаем начисто
    closePinModal();
    toast('Вы вошли как партнёр');
    await Sync.start();
    return;
  }

  if(mode === 'register' && login.indexOf('@') === -1){ pinFail('Введите e-mail, например ivan@mail.ru'); return; }
  setSyncLine('Проверяем…');
  const res = await Sync.signIn(login, password, mode === 'register' ? 'register' : 'login');
  document.getElementById('pinSubmit').disabled = false;
  if(!res.ok){
    pinFail(res.error || 'Не удалось войти');
    setSyncLine(describeSync('signed-out'));
    return;
  }
  if(res.switched){ location.reload(); return; }
  closePinModal();
  toast(res.created ? 'Новый склад создан' : 'Вход выполнен');
  await Sync.start();
}

async function renderSyncStatusBox(){
  const el = document.getElementById('syncStatusBox');
  if(!el) return;
  if(!window.Sync || !Sync.isConfigured()){
    el.className = 'alert';
    el.innerHTML = '<svg class="icon"><use href="#i-alert"/></svg><span>Синхронизация не настроена — приложение работает только на этом устройстве.</span>';
    return;
  }
  const user = await Sync.currentUser();
  if(!user){
    el.className = 'alert danger';
    el.innerHTML = '<svg class="icon"><use href="#i-alert"/></svg><span>Вход не выполнен. Данные остаются только здесь.</span>'
                 + '<button class="btn primary sm" style="margin-left:auto;width:auto;" onclick="openPinModal(\'login\')">Войти</button>';
    return;
  }
  const pending = (await getDirty('history')).length + (await getDirty('products')).length + (await getDirty('adspend')).length;
  const login = (user.email || '').replace(/@sklad\.app$/,'') || (Sync.lastLogin ? Sync.lastLogin() : '') || 'вход выполнен';
  const role = (Sync.role && Sync.role() === 'employee')
      ? ('партнёр' + (Sync.memberName && Sync.memberName() ? ': ' + Sync.memberName() : ''))
      : 'владелец';
  el.className = pending ? 'alert' : 'alert success';
  el.innerHTML = '<svg class="icon"><use href="#i-' + (pending ? 'clock' : 'check-circle') + '"/></svg><span>'
               + 'Вход: <b>' + escapeHtml(login) + '</b> (' + escapeHtml(role) + ')<br>'
               + (pending ? ('Ждут отправки: ' + pending + '. Уйдут при первой связи.') : 'Всё синхронизировано между устройствами.')
               + '</span>';
}
async function syncNowFromSettings(){
  if(!window.Sync || !Sync.isConfigured()){ toast('Синхронизация не настроена'); return; }
  const r = await Sync.syncNow('вручную');
  toast(r.ok ? ('Готово. Отправлено: '+(r.sent||0)+', получено: '+(r.received||0)) : ('Не вышло: '+r.error));
  await renderSyncStatusBox();
}

/* Индекс byUid у «истории» не уникальный (техническое ограничение
   IndexedDB) — сама база не мешает одной и той же серверной записи
   осесть локально дважды под разными id. recalcStock теперь защищён от
   этого (считает по уникальным uid), но сами дубли всё равно засоряют
   «Историю» — эта функция физически убирает лишние копии, оставляя по
   каждому uid одну (самую свежую по updatedAt). */
async function dedupeLocalHistory(){
  const all = await getAll('history');
  const keep = new Map();
  const dropIds = [];
  all.forEach(h=>{
    if(!h.uid) return;   // у самодельных легаси-записей без uid дублей не бывает
    const prev = keep.get(h.uid);
    if(!prev){ keep.set(h.uid, h); return; }
    const newer = (Number(h.updatedAt)||0) > (Number(prev.updatedAt)||0) ? h : prev;
    const older = newer === h ? prev : h;
    keep.set(h.uid, newer);
    dropIds.push(older.id);
  });
  for(const id of dropIds){ await del('history', id); }
  return dropIds.length;
}

/* Обычная синхронизация подтягивает только то, что изменилось после курсора,
   и пересчитывает остаток лишь у «задетых» этим товаров. Если у устройства
   когда-то был провал (не докачало часть истории, приложение закрылось
   на середине и т.п.), с этим курсором оно так и останется в неведении —
   различие с другим телефоном само не исчезнет. Здесь курсор сбрасывается
   в ноль (перекачивается вся история заново), убираются дубли записей,
   если они успели накопиться, и остаток пересчитывается у всех товаров
   подряд, а не только у «задетых» — на случай, если локальные записи и
   так были верны, а разошёлся только закэшированный остаток. */
async function fullResyncFromSettings(){
  if(!window.Sync || !Sync.isConfigured()){ toast('Синхронизация не настроена'); return; }
  if(!confirm('Полностью пересинхронизировать данные с сервером?\n\nПрограмма заново скачает всю историю операций, уберёт задвоенные записи (если есть) и пересчитает остатки на этом устройстве. Нужно, если остатки не совпадают с другим телефоном. На большом складе может занять минуту.')) return;
  toast('Пересинхронизация…');
  await window.put('settings', {key:'syncCursor', value: 0});
  const r = await Sync.syncNow('полная пересинхронизация');
  const dupCount = await dedupeLocalHistory();
  const all = await getAllLive('products');
  for(const p of all){ await recalcStock(p.sku); }
  toast(r.ok
    ? ('Готово. Остатки пересчитаны у ' + all.length + ' ' + pluralTovar(all.length) + (dupCount ? ('; убрано дублей: ' + dupCount) : '') + '.')
    : ('Не вышло: ' + r.error));
  await renderSyncStatusBox();
  await renderStock();
}
/* После выхода данные склада с устройства стираются: за этим компьютером
   может работать другой человек со своим аккаунтом. Всё хранится на
   сервере и вернётся при следующем входе — поэтому сначала досылаем то,
   что ещё не уехало, и предупреждаем, если дослать не вышло. */
async function syncSignOut(){
  if(!confirm('Выйти из аккаунта на этом устройстве?\n\nДанные склада сохранены на сервере и вернутся, когда войдёте снова. С этого устройства они будут убраны.')) return;
  if(navigator.onLine){ try{ await Sync.syncNow('выход'); }catch(e){} }
  const left = await countUnsent();
  if(left > 0 && !confirm('Не отправлено на сервер: ' + left + ' изменений (нет связи?). При выходе они пропадут.\n\nВсё равно выйти?')) return;
  await Sync.signOut();
  await wipeAccountData();
  location.reload();
}

async function initSync(){
  if(!window.Sync || !Sync.isConfigured()) { setSyncLine(describeSync('signed-out')); return; }
  Sync.onStatus((state, detail)=> setSyncLine(describeSync(state, detail)));
  window.refreshAfterSync = refreshAfterSync;

  const started = await Sync.start();
  if(!started) openPinModal('login');
  await applyRoleUI();
}

function hideSplash(){
  const el = document.getElementById('splashScreen');
  if(el) el.classList.add('hide');
}

function syncInvActionUI(){
  document.getElementById('invActionsIdle').style.display = inventoryActive ? 'none' : 'flex';
  document.getElementById('invActionsActive').style.display = inventoryActive ? 'flex' : 'none';
  document.getElementById('invScanCard').style.display = inventoryActive ? 'block' : 'none';
}

async function updateProductCountPill(){
  const all = await getAllLive('products');
  const n = all.length;
  const word = n%10===1 && n%100!==11 ? 'товар' : (n%10>=2 && n%10<=4 && !(n%100>=12&&n%100<=14) ? 'товара' : 'товаров');
  document.getElementById('productCountPill').textContent = n.toLocaleString('ru-RU')+' '+word;
}

function showSection(name, btn){
  // сотруднику доступны только его вкладки
  if(isEmployee() && EMP_SECTIONS.indexOf(name) === -1){ name = 'stock'; btn = null; }
  document.querySelectorAll('main section').forEach(s=>s.classList.remove('active'));
  document.getElementById('sec-'+name).classList.add('active');
  document.querySelectorAll('nav.bottom button').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  closeChromeMenu();
  try{ window.scrollTo(0,0); }catch(e){}
  if(name==='panel'){ focusForScanner(document.getElementById('scanInput')); renderReorderCard(); }
  if(name==='stock') renderStock();
  if(name==='inv') renderInvList();
  if(name==='returns') renderReturns();
  if(name==='history') renderHistory();
  if(name==='stats') { renderStats(); renderReports(); }
  if(name==='settings'){ renderStorageStatus(); renderSyncStatusBox(); renderSoundRows(); renderSnapshots(); }
  if(name==='finance') { renderFinance(currentFinancePeriod, null); renderFinSubTab(); }
  if(name==='balance') { renderBalance(currentBalancePeriod, null); }
}
/* Переход с плитки: подсвечиваем и кнопку нижнего меню этого раздела. */
function goSection(name){
  showSection(name, document.querySelector('nav.bottom button[onclick*="\'' + name + '\'"]'));
}
function openSettings(){
  closeChromeMenu();
  showSection('settings', null);
}

