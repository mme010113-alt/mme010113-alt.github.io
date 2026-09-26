/* «Склад»: Вход, состояние синхронизации, навигация по вкладкам. */
/* ============================================================
   СИНХРОНИЗАЦИЯ: ВХОД И СОСТОЯНИЕ
   Приложение остаётся полностью рабочим без входа — тогда оно просто
   живёт на одном устройстве, как раньше. Вход включает обмен с сервером.
   ============================================================ */
function setSyncLine(text){
  const el = document.getElementById('syncLine');
  if(el) el.textContent = text;
}

function describeSync(state, detail){
  detail = detail || {};
  /* Коротко: строка живёт в шапке рядом с кнопками и обрезается. */
  if(state === 'syncing') return 'Синхронизация…';
  if(state === 'offline') return (detail.pending ? 'Нет сети · ждут: '+detail.pending : 'Нет сети');
  if(state === 'signed-out') return 'Только это устройство';
  if(state === 'error') return 'Обмен не удался';
  if(state === 'idle'){
    if(detail.pending) return 'Ждут отправки: ' + detail.pending;
    const t = detail.at ? new Date(detail.at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}) : '';
    return t ? ('Синхронизировано в ' + t) : 'Синхронизировано';
  }
  return 'Данные на этом устройстве';
}

/* Вызывается синхронизацией, когда с сервера прилетели чужие изменения. */
async function refreshAfterSync(){
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

function openPinModal(mode){
  const bg = document.getElementById('pinModalBg');
  if(!bg) return;
  const isChange = (mode === 'change');
  document.getElementById('pinError').classList.remove('show');
  const pass = document.getElementById('pinInput');
  pass.value = '';
  pass.type = 'password';
  pass.setAttribute('autocomplete', isChange ? 'new-password' : 'current-password');
  document.getElementById('pinEye').classList.remove('on');
  document.getElementById('pinEye').innerHTML = '<svg class="icon"><use href="#i-eye"/></svg>';

  document.getElementById('loginField').style.display = isChange ? 'none' : 'block';
  document.getElementById('loginInput').value = (window.Sync && Sync.lastLogin) ? Sync.lastLogin() : '';
  document.getElementById('pinTitle').textContent = isChange ? 'Новый пароль' : 'Вход в склад';
  document.getElementById('pinHint').textContent = isChange
      ? 'Придумайте новый пароль, не короче 6 символов. На других устройствах нужно будет войти заново.'
      : 'Один вход на телефон, планшет и компьютер — данные едут между ними сами.';
  const note = document.querySelector('.auth-note');
  if(note) note.style.display = isChange ? 'none' : 'block';
  document.querySelectorAll('.auth-skip').forEach(b=>{ b.style.display = isChange ? 'none' : 'block'; });

  // сброс режима «вход партнёра»
  bg.dataset.emp = '0';
  const ef = document.getElementById('empFields'); if(ef) ef.hidden = true;
  const etb = document.getElementById('empToggleBtn'); if(etb) etb.textContent = 'Войти как партнёр';

  bg.dataset.mode = mode || 'login';
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
    const si = await Sync.signIn(login, password);
    if(!si.ok){ pinFail(si.error || 'Не удалось войти'); setSyncLine(describeSync('signed-out')); return; }
    const jr = await Sync.joinWorkspace(code, '');
    document.getElementById('pinSubmit').disabled = false;
    if(!jr.ok){ pinFail(jr.error || 'Не удалось присоединиться по коду'); return; }
    closePinModal();
    toast('Вы вошли как партнёр');
    await Sync.start();
    return;
  }

  setSyncLine('Проверяем…');
  const res = await Sync.signIn(login, password);
  document.getElementById('pinSubmit').disabled = false;
  if(!res.ok){
    pinFail(res.error || 'Не удалось войти');
    setSyncLine(describeSync('signed-out'));
    return;
  }
  closePinModal();
  toast(res.created ? 'Склад привязан к этому логину' : 'Вход выполнен');
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
async function syncSignOut(){
  if(!confirm('Выйти из аккаунта на этом устройстве?\n\nДанные склада останутся здесь, но синхронизация с другими устройствами прекратится, пока не войдёте снова.')) return;
  await Sync.signOut();
  if(typeof applyRoleUI === 'function') await applyRoleUI();
  await renderSyncStatusBox();
  toast('Вы вышли из аккаунта');
  openPinModal('login');
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
  document.getElementById('productCountPill').textContent = n+' '+word;
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
function openSettings(){
  closeChromeMenu();
  showSection('settings', null);
}

