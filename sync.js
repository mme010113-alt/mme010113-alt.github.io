/* ============================================================
   СИНХРОНИЗАЦИЯ МЕЖДУ УСТРОЙСТВАМИ
   ============================================================
   Правила, на которых всё держится:

   1. Приложение остаётся офлайн-первым. Сканирование пишет в местную базу
      и работает без связи; на сервер изменения уезжают, когда связь есть.
   2. Остаток нигде не передаётся — он вычисляется из операций. Поэтому две
      операции, сделанные офлайн на разных устройствах, складываются, а не
      затирают друг друга.
   3. Удаления мягкие. Физически стёртая строка вернулась бы с другого
      устройства при следующем сеансе связи.
   4. Карточка товара разрешается по времени правки: кто отредактировал
      позже, того и версия. Для справочных полей этого достаточно.
   ============================================================ */

(function(){
  'use strict';

  const CFG = window.SYNC_CONFIG || {};
  let client = null;
  let channel = null;
  let syncing = false;
  let queuedRun = false;
  let currentRun = null;

  const listeners = [];
  function onStatus(fn){ listeners.push(fn); }
  function emit(state, detail){ listeners.forEach(fn=>{ try{ fn(state, detail); }catch(e){} }); }

  /* Логин человек придумывает сам («sklad», «ivan»), а сервер опознаёт
     учётные записи по адресу почты — поэтому логин достраивается до адреса.
     Если ввели настоящую почту, оставляем как есть. */
  function loginToEmail(login){
    const v = String(login || '').trim().toLowerCase();
    if(!v) return '';
    if(v.indexOf('@') !== -1) return v;
    return v.replace(/[^a-z0-9._-]/g, '') + '@sklad.app';
  }
  const LAST_LOGIN_KEY = 'sklad-last-login';
  function rememberLogin(login){
    try{ localStorage.setItem(LAST_LOGIN_KEY, String(login||'').trim()); }catch(e){}
  }
  function lastLogin(){
    try{ return localStorage.getItem(LAST_LOGIN_KEY) || ''; }catch(e){ return ''; }
  }

  function ready(){
    return Boolean(client && CFG.url && CFG.key);
  }

  function init(){
    if(client) return client;
    if(!CFG.url || !CFG.key || !window.supabase) return null;
    client = window.supabase.createClient(CFG.url, CFG.key, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sklad-auth' }
    });
    return client;
  }

  async function currentUser(){
    if(!init()) return null;
    try{
      const {data} = await client.auth.getUser();
      return data ? data.user : null;
    }catch(e){ return null; }
  }

  /* Первый вход на первом устройстве заводит учётную запись, на остальных —
     просто входит. Разделять эти случаи вручную пользователю не нужно. */
  async function signIn(login, password){
    if(!init()) return {ok:false, error:'Синхронизация не настроена'};
    const email = loginToEmail(login);
    if(!email) return {ok:false, error:'Укажите логин'};
    if(String(password || '').length < 6) return {ok:false, error:'Пароль — не короче 6 символов'};

    let res = await client.auth.signInWithPassword({email, password});
    if(!res.error){ rememberLogin(login); return {ok:true, created:false}; }

    const msg = String(res.error.message || '');
    if(/invalid login credentials/i.test(msg)){
      // либо такой учётки ещё нет, либо пароль неверный — пробуем завести
      const signUp = await client.auth.signUp({email, password});
      if(signUp.error){
        const m = String(signUp.error.message || '');
        if(/already registered|already exists/i.test(m)) return {ok:false, error:'Неверный пароль для этого логина'};
        return {ok:false, error: m};
      }
      if(!signUp.data || !signUp.data.session){
        return {ok:false, error:'В Supabase включено подтверждение почты — выключите Authentication → Providers → Email → Confirm email'};
      }
      rememberLogin(login);
      return {ok:true, created:true};
    }
    return {ok:false, error: msg};
  }

  async function signOut(){
    stopRealtime();
    membership = null;
    inviteCode = null;
    writeCachedMembership(null);
    if(client) { try{ await client.auth.signOut(); }catch(e){} }
    emit('signed-out');
  }

  async function changePassword(newPassword){
    if(!ready()) return {ok:false, error:'Нет соединения'};
    if(String(newPassword || '').length < 6) return {ok:false, error:'Пароль — не короче 6 символов'};
    const {error} = await client.auth.updateUser({password: newPassword});
    return error ? {ok:false, error:error.message} : {ok:true};
  }

  // ------------------------------------------------------------------
  // РОЛИ: владелец пространства или сотрудник, присоединённый по коду
  // ------------------------------------------------------------------
  /* membership === null  → человек владелец собственного пространства;
     membership объект     → он сотрудник, работает в пространстве owner_id.

     Роль кэшируется в localStorage: иначе при запуске приложение секунду
     показывает интерфейс владельца (все вкладки), пока сходит на сервер за
     составом. С кэшем нужная роль применяется сразу, а сервер только
     подтверждает. */
  const MEMBERSHIP_CACHE_KEY = 'sklad-membership';
  function readCachedMembership(){
    try{
      const m = JSON.parse(localStorage.getItem(MEMBERSHIP_CACHE_KEY) || 'null');
      return (m && m.owner_id) ? m : null;
    }catch(e){ return null; }
  }
  function writeCachedMembership(m){
    try{
      if(m && m.owner_id){
        localStorage.setItem(MEMBERSHIP_CACHE_KEY, JSON.stringify({
          owner_id: m.owner_id, role: m.role || 'employee', name: m.name || ''
        }));
      } else {
        localStorage.removeItem(MEMBERSHIP_CACHE_KEY);
      }
    }catch(e){}
  }
  let membership = readCachedMembership();
  let inviteCode = null;   // код-приглашения владельца (для показа в настройках)

  async function resolveMembership(){
    if(!ready()) return membership;              // без связи держимся кэша
    const user = await currentUser();
    if(!user) return membership;                 // сессия могла ещё не восстановиться — кэш не трогаем (чистит только выход)
    try{
      const {data, error} = await client
        .from('workspace_members')
        .select('owner_id, role, name')
        .eq('member_id', user.id)
        .limit(1);
      if(error) throw error;
      membership = (data && data.length) ? data[0] : null;   // достоверный ответ
      writeCachedMembership(membership);
    }catch(e){ /* таблицы нет / нет связи — оставляем прежнее (кэш) */ }
    return membership;
  }

  function role(){ return membership ? (membership.role || 'employee') : 'owner'; }
  function memberName(){ return membership ? (membership.name || 'Сотрудник') : ''; }
  async function myMemberId(){ const u = await currentUser(); return u ? u.id : null; }
  async function workspaceOwnerId(){
    if(membership) return membership.owner_id;
    const u = await currentUser();
    return u ? u.id : null;
  }

  /* Владелец: гарантированно получить свой код (создаётся при первом вызове). */
  async function ensureInviteCode(){
    if(!ready() || membership) return null;
    if(!(await currentUser())) return null;   // без входа кода нет
    try{
      const {data, error} = await client.rpc('ensure_workspace');
      if(!error) inviteCode = data || null;
    }catch(e){}
    return inviteCode;
  }
  async function rotateInviteCode(){
    if(!ready() || membership) return {ok:false, error:'Только для владельца'};
    const {data, error} = await client.rpc('rotate_invite_code');
    if(error) return {ok:false, error:error.message};
    inviteCode = data || null;
    return {ok:true, code:inviteCode};
  }
  function currentInviteCode(){ return inviteCode; }

  /* Сотрудник: присоединиться к пространству по коду. Вызывается сразу
     после signIn — учётная запись у сотрудника своя. */
  async function joinWorkspace(code, name){
    if(!ready()) return {ok:false, error:'Нет соединения'};
    const {data, error} = await client.rpc('join_workspace', {
      p_code: String(code || '').trim(),
      p_name: String(name || '').trim()
    });
    if(error) return {ok:false, error: error.message};
    await resolveMembership();
    return {ok:true, ownerId: data};
  }

  /* Владелец: список партнёров и удаление. */
  async function listMembers(){
    if(!ready() || membership) return [];
    if(!(await currentUser())) return [];   // до входа спрашивать нечего
    const {data, error} = await client
      .from('workspace_members')
      .select('member_id, name, role, created_at')
      .order('created_at', {ascending:true});
    return error ? [] : (data || []);
  }
  async function removeMember(memberId){
    if(!ready() || membership) return {ok:false, error:'Только для владельца'};
    const user = await currentUser();
    const {error} = await client
      .from('workspace_members')
      .delete()
      .eq('owner_id', user.id)
      .eq('member_id', memberId);
    return error ? {ok:false, error:error.message} : {ok:true};
  }

  // ------------------------------------------------------------------
  // преобразование записей: в приложении camelCase, в базе snake_case
  // ------------------------------------------------------------------
  const num = v => Number(v) || 0;

  /* Насколько отматываем курсор назад при каждом приёме — запас на
     расхождение часов между устройствами. */
  const PULL_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

  const MAP = {
    products: {
      table: 'products',
      toRow: (p, uid) => ({
        user_id: uid, sku: String(p.sku), name: p.name || '',
        category: p.category || '', supplier: p.supplier || '', barcode: p.barcode || '',
        cost: num(p.cost), price: num(p.price),
        commission_percent: num(p.commissionPercent), tax_percent: num(p.taxPercent),
        packaging: num(p.packaging), delivery_discount: num(p.deliveryDiscount),
        updated_at: num(p.updatedAt), deleted_at: p.deletedAt || null
      }),
      toLocal: r => ({
        sku: r.sku, name: r.name || '', category: r.category || '',
        supplier: r.supplier || '', barcode: r.barcode || '',
        cost: num(r.cost), price: num(r.price),
        commissionPercent: num(r.commission_percent), taxPercent: num(r.tax_percent),
        packaging: num(r.packaging), deliveryDiscount: num(r.delivery_discount),
        updatedAt: num(r.updated_at), deletedAt: r.deleted_at || undefined,
        totalStock: 0            // пересчитается из операций
      }),
      keyOf: r => r.sku,
      conflict: 'user_id,sku'
    },
    history: {
      table: 'operations',
      toRow: (h, uid) => ({
        user_id: uid, uid: h.uid, sku: String(h.sku || ''), name: h.name || '',
        barcode: h.barcode || '', type: h.type || '', qty: num(h.qty), delta: num(h.delta),
        ts: num(h.timestamp), legacy: Boolean(h.legacy), snap: h.snap || null,
        updated_at: num(h.updatedAt), deleted_at: h.deletedAt || null
      }),
      toLocal: r => {
        const d = new Date(num(r.ts));
        return {
          uid: r.uid, sku: r.sku, name: r.name || '', barcode: r.barcode || '',
          type: r.type, qty: num(r.qty), delta: num(r.delta),
          timestamp: num(r.ts), legacy: Boolean(r.legacy), snap: r.snap || undefined,
          date: d.toLocaleDateString('ru-RU'), time: d.toLocaleTimeString('ru-RU'),
          stockAfter: 0,
          updatedAt: num(r.updated_at), deletedAt: r.deleted_at || undefined
        };
      },
      keyOf: r => r.uid,
      conflict: 'user_id,uid'
    },
    adspend: {
      table: 'adspend',
      toRow: (a, uid) => ({
        user_id: uid, date_key: a.dateKey, amount: num(a.amount),
        ts: num(a.timestamp), updated_at: num(a.updatedAt), deleted_at: a.deletedAt || null
      }),
      toLocal: r => ({
        dateKey: r.date_key, amount: num(r.amount), timestamp: num(r.ts),
        dateDisplay: new Date(num(r.ts)).toLocaleDateString('ru-RU'),
        updatedAt: num(r.updated_at), deletedAt: r.deleted_at || undefined
      }),
      keyOf: r => r.date_key,
      conflict: 'user_id,date_key'
    },
    orders: {
      table: 'orders',
      toRow: (o, uid) => ({
        user_id: uid, uid: o.uid, employee: o.employee || '', member_id: o.memberId || null,
        op_uid: o.opUid || null, source: o.source || 'manual',
        paid: Boolean(o.paid), paid_at: o.paidAt || null,
        amount: num(o.amount), rate_percent: num(o.ratePercent), commission: num(o.commission),
        note: o.note || '', ts: num(o.timestamp), date_key: o.dateKey || '',
        updated_at: num(o.updatedAt), deleted_at: o.deletedAt || null
      }),
      toLocal: r => ({
        uid: r.uid, employee: r.employee || '', memberId: r.member_id || undefined,
        opUid: r.op_uid || undefined, source: r.source || 'manual',
        paid: Boolean(r.paid), paidAt: r.paid_at || undefined,
        amount: num(r.amount),
        ratePercent: num(r.rate_percent), commission: num(r.commission),
        note: r.note || '', timestamp: num(r.ts), dateKey: r.date_key || '',
        dateDisplay: new Date(num(r.ts)).toLocaleDateString('ru-RU'),
        updatedAt: num(r.updated_at), deletedAt: r.deleted_at || undefined
      }),
      keyOf: r => r.uid,
      conflict: 'user_id,uid'
    },
    payouts: {
      table: 'payouts',
      toRow: (p, uid) => ({
        user_id: uid, uid: p.uid, employee: p.employee || '', member_id: p.memberId || null,
        amount: num(p.amount), note: p.note || '',
        ts: num(p.timestamp), date_key: p.dateKey || '',
        updated_at: num(p.updatedAt), deleted_at: p.deletedAt || null
      }),
      toLocal: r => ({
        uid: r.uid, employee: r.employee || '', memberId: r.member_id || undefined,
        amount: num(r.amount), note: r.note || '',
        timestamp: num(r.ts), dateKey: r.date_key || '',
        dateDisplay: new Date(num(r.ts)).toLocaleDateString('ru-RU'),
        updatedAt: num(r.updated_at), deletedAt: r.deleted_at || undefined
      }),
      keyOf: r => r.uid,
      conflict: 'user_id,uid'
    }
  };

  // ------------------------------------------------------------------
  // настройки: название компании, логотип и свои звуки
  // Едут одной записью и целиком — разбирать их по полям нет смысла,
  // а вот застрять на разных устройствах с разными звуками неприятно.
  // ------------------------------------------------------------------
  function settingsToValue(s){
    const copy = Object.assign({}, s);
    delete copy.key; delete copy.dirty;      // служебное наружу не отдаём
    return copy;
  }

  async function pushSettings(uid){
    const local = await window.get('settings', 'app');
    if(!local || !local.dirty) return 0;

    /* На сервере может лежать версия свежее нашей — например, звуки
       поменяли на телефоне, пока это устройство лежало выключенным.
       Отправка «вслепую» затёрла бы их, поэтому уступаем и ждём приёма. */
    const check = await client.from('app_settings').select('updated_at').eq('user_id', uid).eq('key','app').limit(1);
    if(check.error) throw new Error('settings: ' + check.error.message);
    const remoteTime = check.data && check.data.length ? num(check.data[0].updated_at) : 0;
    if(remoteTime > num(local.updatedAt)){
      local.dirty = 0;
      await window.putRaw('settings', local);
      return 0;
    }

    const row = {
      user_id: uid, key: 'app',
      value: settingsToValue(local),
      updated_at: num(local.updatedAt)
    };
    const {error} = await client.from('app_settings').upsert([row], {onConflict:'user_id,key'});
    if(error) throw new Error('settings: ' + error.message);
    local.dirty = 0;
    await window.putRaw('settings', local);
    return 1;
  }

  async function pullSettings(wsOwner){
    const local = await window.get('settings', 'app');
    const localTime = num(local && local.updatedAt);
    let q = client.from('app_settings').select('*').eq('key','app');
    if(wsOwner) q = q.eq('user_id', wsOwner);
    const {data, error} = await q.limit(1);
    if(error) throw new Error('settings: ' + error.message);
    if(!data || !data.length) return 0;

    const remote = data[0];
    if(num(remote.updated_at) <= localTime) return 0;

    const merged = Object.assign({}, remote.value, {
      key: 'app', updatedAt: num(remote.updated_at), dirty: 0
    });
    await window.putRaw('settings', merged);
    if(typeof window.applyRemoteSettings === 'function') window.applyRemoteSettings(merged);
    return 1;
  }

  // ------------------------------------------------------------------
  // отправка своих изменений
  // ------------------------------------------------------------------
  async function pushStore(storeName, uid){
    const spec = MAP[storeName];
    const dirty = await window.getDirty(storeName);
    if(!dirty.length) return 0;

    /* Страховка на случай записей, попавших в базу мимо миграции: без uid
       сервер отказывает всей пачке, и обмен встаёт намертво. */
    if(storeName === 'history'){
      for(const row of dirty){
        if(!row.uid && typeof window.normalizeHistoryRow === 'function'){
          window.normalizeHistoryRow(row);
          await window.put('history', row);
        }
      }
    }

    /* Две локальные строки с одним ключом в одной пачке дают серверную ошибку
       «ON CONFLICT DO UPDATE command cannot affect row a second time» и встают
       обмен намертво. Оставляем на ключ одну — самую свежую; лишние помечаем
       отправленными, они всё равно дубли. */
    const keyCols = spec.conflict.split(',');
    const pairs = dirty.map(r=> ({local:r, row:spec.toRow(r, uid)}));
    const winners = new Map();
    for(const p of pairs){
      const k = keyCols.map(c=> String(p.row[c])).join('|');
      const cur = winners.get(k);
      if(!cur || (p.local.updatedAt||0) >= (cur.local.updatedAt||0)) winners.set(k, p);
    }
    const unique = pairs.filter(p=> winners.get(keyCols.map(c=> String(p.row[c])).join('|')) === p);
    const dupes = pairs.filter(p=> !unique.includes(p));

    // порциями: одним запросом на тысячи строк упрёмся в лимит тела
    const CHUNK = 200;
    const keyCol = keyCols[1];
    for(let i=0;i<unique.length;i+=CHUNK){
      const slice = unique.slice(i, i+CHUNK);

      /* Сервер принимает запись «вслепую», поэтому устаревшая правка (или
         живая карточка товара) затирала бы более свежее — например, удаление,
         сделанное на другом телефоне. Если на сервере запись новее нашей,
         уступаем: её привезёт приём. */
      const remoteTime = new Map();
      for(let j=0;j<slice.length;j+=50){
        const keys = slice.slice(j, j+50).map(p=> String(p.row[keyCol]));
        const chk = await client.from(spec.table).select(keyCol + ',updated_at')
          .eq('user_id', uid).in(keyCol, keys);
        if(chk.error) throw new Error(spec.table + ': ' + chk.error.message);
        (chk.data || []).forEach(r=> remoteTime.set(String(r[keyCol]), num(r.updated_at)));
      }
      const send = slice.filter(p=>{
        const t = remoteTime.get(String(p.row[keyCol]));
        return !(t !== undefined && t > num(p.row.updated_at));
      });

      if(send.length){
        const {error} = await client.from(spec.table).upsert(send.map(p=>p.row), {onConflict: spec.conflict});
        if(error) throw new Error(spec.table + ': ' + error.message);
      }
      const sentSet = new Set(send);
      for(const p of slice){
        p.local.dirty = 0;
        if(storeName === 'history' && sentSet.has(p)){
          const prevEff = p.local.srvEff, prevSku = p.local.srvSku;
          p.local.srvEff = window.opEffect(p.local);
          p.local.srvSku = p.local.sku;
          await window.put(storeName, p.local, {fromSync:true});
          await window.serverStockNotePushed(p.local, prevEff, prevSku);
        } else {
          await window.put(storeName, p.local, {fromSync:true});
        }
      }
    }
    for(const p of dupes){
      p.local.dirty = 0;
      await window.put(storeName, p.local, {fromSync:true});
    }
    return dirty.length;
  }

  // ------------------------------------------------------------------
  // приём чужих изменений
  // ------------------------------------------------------------------
  async function pullStore(storeName, since){
    const spec = MAP[storeName];
    /* Сервер отдаёт за раз не больше 1000 строк, а одним запросом с лимитом
       больше он молча обрежет — поэтому листаем страницами, пока не кончатся. */
    const PAGE = 1000;
    const keyCol = spec.conflict.split(',')[1];
    const data = [];
    for(let from = 0; ; from += PAGE){
      const page = await client
        .from(spec.table)
        .select('*')
        .gt('updated_at', since)
        .order('updated_at', {ascending:true})
        .order(keyCol, {ascending:true})
        .range(from, from + PAGE - 1);
      if(page.error) throw new Error(spec.table + ': ' + page.error.message);
      const chunk = page.data || [];
      data.push(...chunk);
      if(chunk.length < PAGE) break;
    }
    if(!data.length) return {applied:0, maxUpdated:since, touchedSkus:[]};

    let maxUpdated = since;
    const touched = new Set();
    let applied = 0;

    for(const row of data){
      maxUpdated = Math.max(maxUpdated, num(row.updated_at));
      const incoming = spec.toLocal(row);
      const key = spec.keyOf(row);

      if(storeName === 'history'){
        incoming.srvEff = window.opEffect(incoming);   // что об этой записи знает сервер
        incoming.srvSku = incoming.sku;
        /* историю ищем по uid: локальный ключ (автоинкремент) на разных
           устройствах свой и для поиска не годится */
        const local = await findByUid(row.uid);
        if(local){
          // операции не редактируются, меняется только признак удаления
          if(local.deletedAt !== incoming.deletedAt || num(local.updatedAt) < num(incoming.updatedAt)){
            incoming.id = local.id;
            await window.put('history', incoming, {fromSync:true});
            applied++;
            touched.add(incoming.sku);
          }
        } else {
          await window.put('history', incoming, {fromSync:true});
          applied++;
          touched.add(incoming.sku);
        }
        continue;
      }

      const existing = await window.get(storeName, key);
      if(!existing || num(existing.updatedAt) <= num(incoming.updatedAt)){
        if(storeName === 'products' && existing) incoming.totalStock = existing.totalStock;
        await window.put(storeName, incoming, {fromSync:true});
        applied++;
        if(storeName === 'products') touched.add(incoming.sku);
      }
    }
    return {applied, maxUpdated, touchedSkus:[...touched]};
  }

  function findByUid(uid){
    return new Promise((res,rej)=>{
      const r = window.tx('history').index('byUid').get(uid);
      r.onsuccess = ()=> res(r.result);
      r.onerror = rej;
    });
  }

  // ------------------------------------------------------------------
  // главное устройство
  // Владелец с телефона, отмеченного «главным», может раздать свои данные
  // на всё: сервер становится копией этого телефона, а остальные
  // устройства при следующей связи сбрасывают свои данные и скачивают
  // сервер заново. «Эпоха» — отметка времени последней такой раздачи:
  // устройство, у которого записана более старая, обязано сбросить всё.
  // ------------------------------------------------------------------
  const EPOCH_KEY = 'masterEpoch';
  const LOCAL_KEY = {
    products: r=> r.sku, history: r=> r.uid, adspend: r=> r.dateKey,
    orders: r=> r.uid, payouts: r=> r.uid
  };

  /* Замер остатков сервером (представление product_stock). Если его нет
     (схему не обновили) — возвращаем null, и телефон считает по-старому. */
  async function fetchServerStock(wsOwner){
    const PAGE = 1000, map = {};
    for(let from = 0; ; from += PAGE){
      const {data, error} = await client.from('product_stock').select('sku,stock')
        .eq('user_id', wsOwner).order('sku', {ascending:true}).range(from, from + PAGE - 1);
      if(error) return null;
      (data || []).forEach(r=> map[r.sku] = num(r.stock));
      if(!data || data.length < PAGE) break;
    }
    return map;
  }
  async function refreshServerStock(wsOwner){
    const map = await fetchServerStock(wsOwner);
    if(map && typeof window.applyServerStock === 'function') await window.applyServerStock(map);
    /* Замера нет, а чужие операции могли уже прийти — старый замер их не
       знает. Возвращаемся к подсчёту по своей истории, пока замер не придёт. */
    if(!map && typeof window.dropServerStock === 'function') await window.dropServerStock();
    return !!map;
  }

  async function readRemoteEpoch(wsOwner){
    const {data, error} = await client.from('app_settings').select('updated_at')
      .eq('user_id', wsOwner).eq('key', EPOCH_KEY).limit(1);
    if(error) throw new Error('epoch: ' + error.message);
    return data && data.length ? num(data[0].updated_at) : 0;
  }

  /* Если после раздачи у нас записана более старая эпоха — стираем свои
     данные (в том числе неотправленные: главный телефон важнее) и качаем
     сервер с нуля. */
  async function adoptEpochIfNeeded(wsOwner, stores){
    const remote = await readRemoteEpoch(wsOwner);
    const row = await window.get('settings', 'syncEpoch');
    if(remote <= num(row && row.value)) return false;
    for(const s of stores){ await window.clearStore(s); }
    if(typeof window.serverStockReset === 'function') await window.serverStockReset();
    await window.put('settings', {key:'syncCursor', value: 0});
    await window.put('settings', {key:'syncEpoch', value: remote});
    return true;
  }

  async function listServerLiveKeys(table, keyCol, wsOwner){
    const PAGE = 1000, keys = [];
    for(let from = 0; ; from += PAGE){
      const {data, error} = await client.from(table).select(keyCol)
        .eq('user_id', wsOwner).is('deleted_at', null)
        .order(keyCol, {ascending:true}).range(from, from + PAGE - 1);
      if(error) throw new Error(table + ': ' + error.message);
      const chunk = data || [];
      chunk.forEach(r=> keys.push(String(r[keyCol])));
      if(chunk.length < PAGE) break;
    }
    return keys;
  }

  /* uid всех живых операций на сервере — для самолечения: запись, которой
     на сервере нет, а на телефоне она «отправлена», — сбойный дубль. */
  async function serverLiveUids(){
    const user = await currentUser();
    if(!ready() || !user) return null;
    const wsOwner = membership ? membership.owner_id : user.id;
    try{ return new Set(await listServerLiveKeys('operations', 'uid', wsOwner)); }
    catch(e){ return null; }
  }

  /* prepare — что сделать с данными телефона под той же блокировкой, до
     раздачи (откат копии): иначе плановый обмен посреди подмены вернул бы
     в очищенную базу лишние строки с сервера. */
  async function publishAsMaster(onProgress, prepare){
    const say = t=>{ try{ if(onProgress) onProgress(t); }catch(e){} };
    if(!ready()) return {ok:false, error:'нет настроек'};
    if(membership) return {ok:false, error:'раздавать данные может только владелец'};
    if(!navigator.onLine) return {ok:false, error:'нет сети'};
    const user = await currentUser();
    if(!user) return {ok:false, error:'не выполнен вход'};

    if(currentRun){ try{ await currentRun; }catch(e){} }
    let resolveRun;
    currentRun = new Promise(r=>{ resolveRun = r; });
    syncing = true;
    emit('syncing', {reason:'главное устройство'});
    try{
      if(prepare) await prepare();
      const wsOwner = user.id;
      const stores = ['products','history','adspend','orders','payouts'];
      const optional = new Set(['orders','payouts']);
      const missingTable = e => /does not exist|schema cache|Could not find the table/i.test(String(e && e.message || e));

      /* Эпоху объявляем ПЕРВОЙ: остальные устройства, увидев её, сотрут свои
         (возможно, устаревшие) неотправленные записи, а не вольют их в сервер
         поверх наших. */
      const now = Date.now();
      const ep = await client.from('app_settings').upsert(
        [{user_id: wsOwner, key: EPOCH_KEY, value: {by:'master'}, updated_at: now}],
        {onConflict:'user_id,key'});
      if(ep.error) throw new Error('epoch: ' + ep.error.message);
      await window.put('settings', {key:'syncEpoch', value: now});

      if(typeof window.repairHistoryRows === 'function') await window.repairHistoryRows();

      let sent = 0, removed = 0;
      for(const s of stores){
        try{
          const spec = MAP[s];
          const keyCol = spec.conflict.split(',')[1];
          const local = await window.getAll(s);

          say('Сверяю с сервером: ' + spec.table + '…');
          const liveKeys = new Set(local.filter(r=> !r.deletedAt).map(r=> String(LOCAL_KEY[s](r))));
          const extra = (await listServerLiveKeys(spec.table, keyCol, wsOwner)).filter(k=> !liveKeys.has(k));
          const t = Date.now();
          for(let i=0; i<extra.length; i+=50){
            const {error} = await client.from(spec.table)
              .update({deleted_at: t, updated_at: t})
              .eq('user_id', wsOwner).in(keyCol, extra.slice(i, i+50));
            if(error) throw new Error(spec.table + ': ' + error.message);
          }
          removed += extra.length;

          say('Отправляю: ' + spec.table + '…');
          for(const r of local){ await window.put(s, r); }   // всё считаем «новым» — отправится целиком
          sent += await pushStore(s, wsOwner);
        }catch(e){
          if(optional.has(s) && missingTable(e)) continue;
          throw e;
        }
      }

      await refreshServerStock(wsOwner);
      const pending = (await window.getDirty('history')).length;
      emit('idle', {sent, received:0, pending, at: Date.now()});
      return {ok:true, sent, removed};
    }catch(e){
      emit('error', {message: e.message});
      return {ok:false, error: e.message};
    }finally{
      syncing = false;
      currentRun = null;
      if(resolveRun) resolveRun();
    }
  }

  // ------------------------------------------------------------------
  // резервные копии на сервере (таблица snapshots, функция take_snapshot)
  // ------------------------------------------------------------------
  const SNAP_TABLES = {products:'products', operations:'history', orders:'orders', payouts:'payouts', adspend:'adspend'};

  async function takeSnapshot(kind){
    if(!ready() || membership) return {ok:false, error:'только владелец'};
    const {data, error} = await client.rpc('take_snapshot', {p_kind: kind || 'manual'});
    return error ? {ok:false, error:error.message} : {ok:true, id:data};
  }
  async function listSnapshots(){
    if(!ready() || membership) return [];
    const user = await currentUser(); if(!user) return [];
    const {data, error} = await client.from('snapshots').select('id,kind,taken_at,counts')
      .eq('user_id', user.id).order('taken_at', {ascending:false}).limit(60);
    if(error) throw new Error(error.message);
    return data || [];
  }

  /* Откат: снимок становится данными этого телефона, а потом раздаётся на
     все как с главного устройства. Перед этим — копия «до отката». */
  async function restoreSnapshot(id, onProgress){
    const say = t=>{ try{ if(onProgress) onProgress(t); }catch(e){} };
    if(!ready() || membership) return {ok:false, error:'только владелец'};
    if(!navigator.onLine) return {ok:false, error:'нет сети'};
    say('Скачиваю копию…');
    const {data, error} = await client.from('snapshots').select('data').eq('id', id).limit(1);
    if(error) return {ok:false, error:error.message};
    if(!data || !data.length) return {ok:false, error:'копия не найдена'};
    const snap = data[0].data || {};

    say('Сохраняю нынешнее состояние…');
    const before = await takeSnapshot('before-restore');
    if(!before.ok) return {ok:false, error:'не удалось сохранить копию «до отката»: ' + before.error};

    const r = await publishAsMaster(say, async ()=>{
      say('Раскладываю копию…');
      window.bulkBegin();
      try{
        for(const [table, store] of Object.entries(SNAP_TABLES)){
          await window.clearStore(store);
          for(const row of (snap[table] || [])){
            await window.put(store, MAP[store].toLocal(row));
          }
        }
        await window.serverStockReset();
      }finally{ window.bulkEnd(); }
      say('Раздаю на все телефоны…');
    });
    return r.ok ? {ok:true, beforeId: before.id} : r;
  }

  // ------------------------------------------------------------------
  // полный сеанс связи
  // ------------------------------------------------------------------
  /* Своя же отправка приходит обратно событием realtime и запускает второй
     цикл. Раньше он молча «схлопывался» и возвращал ничего — из-за этого
     вызывающий думал, что обмен прошёл, хотя приём не выполнялся.
     Теперь параллельный вызов дожидается текущего и при необходимости
     повторяет обмен. */
  async function syncNow(reason){
    if(!ready()){ return {ok:false, error:'нет настроек'}; }
    if(currentRun){
      queuedRun = true;
      try{ await currentRun; }catch(e){}
      if(queuedRun){ queuedRun = false; return runSync(reason); }
      return {ok:true, sent:0, received:0, coalesced:true};
    }
    return runSync(reason);
  }

  async function runSync(reason){
    if(!navigator.onLine){ emit('offline'); return {ok:false, error:'нет сети'}; }

    const user = await currentUser();
    if(!user){ emit('signed-out'); return {ok:false, error:'не выполнен вход'}; }

    let resolveRun;
    currentRun = new Promise(r=>{ resolveRun = r; });
    syncing = true;
    emit('syncing', {reason});
    try{
      /* orders/payouts появились позже: если схему в Supabase ещё не
         обновили, обращение к этим таблицам падает с «relation does not
         exist». Раньше это валило весь обмен — и товары с операциями тоже
         переставали синхронизироваться. Поэтому по новым таблицам ошибку
         «нет таблицы» глотаем, остальное работает как прежде. */
      const optional = new Set(['orders','payouts']);
      const missingTable = e => /does not exist|schema cache|Could not find the table/i.test(String(e && e.message || e));
      const guard = async (store, fn) => {
        try{ return await fn(); }
        catch(e){ if(optional.has(store) && missingTable(e)) return 0; throw e; }
      };

      /* Сотрудник ничего не пишет в общие данные и не видит рекламу.
         Владелец — как раньше. wsOwner: чей это склад (для сотрудника —
         владелец пространства, для владельца — он сам). */
      const emp = !!membership;
      const wsOwner = emp ? membership.owner_id : user.id;
      const pushList = emp ? [] : ['products','history','adspend','orders','payouts'];
      const pullList = emp ? ['products','history','orders','payouts']
                           : ['products','history','adspend','orders','payouts'];

      /* Главный телефон раздал данные после нашей последней связи — своё
         стираем до отправки, чтобы старые правки не затёрли серверные. */
      const mirrored = await adoptEpochIfNeeded(wsOwner, pullList);

      let sent = 0;
      for(const s of pushList){
        sent += await guard(s, ()=> pushStore(s, wsOwner));
      }
      if(!emp) sent += await pushSettings(wsOwner);

      const cursorRow = await window.get('settings','syncCursor');
      const saved = cursorRow ? num(cursorRow.value) : 0;

      /* Время правки ставит само устройство, а часы у телефона и компьютера
         сходятся не всегда. Запись, сделанная на отставшем устройстве, имеет
         время «в прошлом» и при выборке строго после курсора не приехала бы
         никогда — обмен тихо переставал возить часть данных. Поэтому берём
         с запасом: лишнее всё равно отсеется сравнением времени правки. */
      const since = Math.max(0, saved - PULL_WINDOW_MS);

      /* Курсор один на все таблицы, поэтому каждой отдаём ОДНО И ТО ЖЕ
         начальное значение. Если двигать его прямо в цикле, таблица,
         обработанная первой, утащит курсор вперёд, и записи остальных,
         сохранённые чуть раньше, будут отброшены как старые. */
      let received = 0;
      let newCursor = saved;
      const skus = new Set();
      for(const s of pullList){
        const r = await guard(s, ()=> pullStore(s, since))
              || {applied:0, maxUpdated:since, touchedSkus:[]};
        received += r.applied;
        newCursor = Math.max(newCursor, r.maxUpdated);
        r.touchedSkus.forEach(x=> skus.add(x));
      }
      received += await pullSettings(wsOwner);
      /* Одна запись с часами «из будущего» иначе увела бы курсор вперёд на
         годы, и приём встал бы намертво. */
      newCursor = Math.min(newCursor, Date.now());
      await window.put('settings', {key:'syncCursor', value: newCursor});

      /* Эталонный остаток — от сервера; без него (старая схема) считаем
         по-старому, только у затронутых товаров. */
      const measured = await refreshServerStock(wsOwner);
      if(!measured){ for(const sku of skus){ await window.recalcStock(sku); } }
      const stockChanged = window.lastStockChangeCount > 0;
      if(mirrored && typeof window.toast === 'function') window.toast('Данные обновлены с главного телефона');

      const pending = (await window.getDirty('history')).length
                    + (await window.getDirty('products')).length
                    + (await window.getDirty('adspend')).length
                    + (await window.getDirty('orders')).length
                    + (await window.getDirty('payouts')).length;

      emit('idle', {sent, received, pending, at: Date.now()});
      if((received || stockChanged) && typeof window.refreshAfterSync === 'function') await window.refreshAfterSync();
      return {ok:true, sent, received};
    }catch(e){
      emit('error', {message: e.message});
      return {ok:false, error: e.message};
    }finally{
      syncing = false;
      currentRun = null;
      if(resolveRun) resolveRun();
    }
  }

  // ------------------------------------------------------------------
  // мгновенные обновления с других устройств
  // ------------------------------------------------------------------
  function startRealtime(){
    if(!ready() || channel) return;
    channel = client.channel('sklad-sync')
      .on('postgres_changes', {event:'*', schema:'public', table:'operations'}, ()=> syncNow('чужая операция'))
      .on('postgres_changes', {event:'*', schema:'public', table:'products'},   ()=> syncNow('чужой товар'))
      .on('postgres_changes', {event:'*', schema:'public', table:'adspend'},    ()=> syncNow('чужая реклама'))
      .on('postgres_changes', {event:'*', schema:'public', table:'orders'},     ()=> syncNow('чужой заказ'))
      .on('postgres_changes', {event:'*', schema:'public', table:'payouts'},    ()=> syncNow('чужая выплата'))
      .on('postgres_changes', {event:'*', schema:'public', table:'app_settings'}, ()=> syncNow('чужие настройки'))
      .on('postgres_changes', {event:'*', schema:'public', table:'workspace_members'}, async ()=>{
        await resolveMembership();
        if(typeof window.applyRoleUI === 'function') window.applyRoleUI();
        syncNow('состав сотрудников');
      })
      .subscribe();
  }
  function stopRealtime(){
    if(channel && client){ try{ client.removeChannel(channel); }catch(e){} }
    channel = null;
  }

  async function start(){
    if(!init()) return false;
    const user = await currentUser();
    if(!user){ emit('signed-out'); return false; }
    await resolveMembership();
    if(!membership) await ensureInviteCode();   // владелец — заводим код при первом запуске
    if(typeof window.applyRoleUI === 'function') window.applyRoleUI();
    startRealtime();
    await syncNow('запуск');
    /* подстраховка ночной копии сервера: если сегодня её ещё нет — сделать */
    if(!membership) takeSnapshot('daily').catch(()=>{});
    return true;
  }

  window.addEventListener('online', ()=> syncNow('появилась сеть'));
  window.addEventListener('offline', ()=> emit('offline'));
  // подстраховка на случай, если realtime отвалится незаметно
  setInterval(()=>{ if(ready() && navigator.onLine) syncNow('по расписанию'); }, 120000);

  window.Sync = {
    init, start, signIn, signOut, changePassword, syncNow, currentUser, publishAsMaster, serverLiveUids,
    takeSnapshot, listSnapshots, restoreSnapshot,
    startRealtime, stopRealtime, onStatus, ready, lastLogin,
    isConfigured: ()=> Boolean(CFG.url && CFG.key),
    // роли и кабинет сотрудника
    resolveMembership, role, memberName, myMemberId, workspaceOwnerId,
    joinWorkspace, listMembers, removeMember,
    ensureInviteCode, rotateInviteCode, inviteCode: currentInviteCode
  };
})();
