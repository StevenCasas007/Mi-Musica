/* Mi Música — PWA que reproduce tu música guardada en Google Drive */
(() => {
  const $ = id => document.getElementById(id);
  const audio = $('audio');
  const READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
  const APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';   // carpeta oculta de la app (listas y favoritas)
  const WANT_CLOUD = CONFIG.CLOUD_SYNC !== false;
  const SCOPE = WANT_CLOUD ? READ_SCOPE + ' ' + APPDATA_SCOPE : READ_SCOPE;
  const SCOPE_V = WANT_CLOUD ? 2 : 1;                                       // cambia cuando cambian los permisos
  const API = 'https://www.googleapis.com/drive/v3';

  // ---------- Estado ----------
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  let tracks = [];
  let meta = store.get('meta', {});
  let data = clean(store.get('data', null));
  let tab = 'all', openList = null, query = '', view = 'home';
  let recentIds = store.get('recent', []);
  let sleepAt = 0, sleepAfterSong = false, sleepMinutes = 0;
  let queue = [], qi = -1, shuffle = false;
  let token = null, tokenExp = 0, tokenClient = null;
  let refreshing = null, pendingRefresh = null, started = false, lastAuthFail = 0;
  let loginHint = store.get('hint', ''), cloudOK = false, libraryStale = false, resumeQueue = false;
  let userP = null, currentUid = '';
  let dataFileId = store.get('dataFileId', null), pushTimer = null, pushPending = false, syncing = false, lastPull = 0;
  let currentUrl = null, currentCover = null;
  const cache = new Map();               // id -> Promise<Blob> (precarga)
  const thumbs = new Map();              // id -> URL de miniatura de carátula
  const onlineCovers = store.get('onlineCovers', {});   // id -> URL de carátula en internet
  const noOnline = new Set(store.get('noOnline', []));  // canciones sin resultado en internet

  // ---------- Utilidades ----------
  const fmt = s => { if (!isFinite(s)) return '0:00'; s = Math.floor(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2400); }
  function parseName(name) {
    const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
    const m = base.match(/^(.+?)\s+-\s+(.+)$/);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
  }
  const fold = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');   // "Mañana" -> "manana"
  const byId = id => tracks.find(t => t.id === id);

  // ---------- Carátulas guardadas en el dispositivo (IndexedDB) ----------
  const idb = {
    db: null,
    open() {
      if (!this.db) this.db = new Promise((res, rej) => {
        const r = indexedDB.open('musica', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('thumbs');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this.db;
    },
    async put(k, v) {
      const db = await this.open();
      return new Promise((res, rej) => { const tx = db.transaction('thumbs', 'readwrite'); tx.objectStore('thumbs').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    },
    async all() {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('thumbs'), st = tx.objectStore('thumbs');
        const keys = st.getAllKeys(), vals = st.getAll();
        tx.oncomplete = () => res(keys.result.map((k, i) => [k, vals.result[i]]));
        tx.onerror = () => rej(tx.error);
      });
    }
  };
  async function makeThumb(imgBlob) {
    const bmp = await createImageBitmap(imgBlob);
    const s = 128, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d'), m = Math.min(bmp.width, bmp.height);
    g.drawImage(bmp, (bmp.width - m) / 2, (bmp.height - m) / 2, m, m, 0, 0, s, s);
    return new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  }
  async function saveThumb(id, imgBlob) {
    if (thumbs.has(id)) return true;
    try {
      const tb = await makeThumb(imgBlob); if (!tb) return false;
      thumbs.set(id, URL.createObjectURL(tb)); idb.put(id, tb).catch(() => {});
      return true;
    } catch { return false; }
  }
  idb.all().then(list => { list.forEach(([k, b]) => thumbs.set(k, URL.createObjectURL(b))); render(); }).catch(() => {});

  // ---------- Login con Google ----------
  // Google solo da permisos de 1 hora. Para renovarlos necesita abrir una ventanita, y los
  // navegadores solo la dejan abrir cuando la persona toca la pantalla. Por eso:
  //  - si el permiso vence, la app NO te saca: muestra un aviso "Renovar sesión";
  //  - cualquier toque en la app renueva el permiso solo si le queda poco tiempo.
  const authErr = m => Object.assign(new Error(m), { code: 'AUTH' });
  const tokenOK = () => !!token && Date.now() < tokenExp;
  const authMsg = m => m === 'popup_closed' ? 'Cerraste la ventana de Google antes de terminar. Inténtalo de nuevo.'
    : m === 'popup_failed_to_open' ? 'Tu navegador bloqueó la ventana de Google. Permite las ventanas emergentes e inténtalo de nuevo.'
    : m === 'access_denied' ? 'Google no te dio acceso. Revisa que tu correo esté autorizado.'
    : m === 'google_no_listo' ? 'Google todavía no carga. Revisa tu internet e inténtalo de nuevo.'
    : 'No se pudo iniciar sesión (' + m + ').';
  function showAuthBar(show) { $('authBar').hidden = !show; }
  function waitGoogle(ms) {
    return new Promise(res => {
      const t0 = Date.now();
      (function chk() { if (tokenClient || Date.now() - t0 > ms) return res(); setTimeout(chk, 100); })();
    });
  }

  function settle(err, value) {
    const p = pendingRefresh; pendingRefresh = null; refreshing = null;
    if (!p) return;
    clearTimeout(p.to);
    err ? p.rej(err) : p.res(value);
  }
  function requestToken(prompt) {
    if (refreshing) return refreshing;
    if (!tokenClient) return Promise.reject(authErr('google_no_listo'));
    const pr = new Promise((res, rej) => {
      pendingRefresh = { res, rej, to: setTimeout(() => settle(authErr('timeout')), 40000) };
    });
    refreshing = pr;
    try { tokenClient.requestAccessToken({ prompt, ...(loginHint ? { hint: loginHint } : {}) }); }
    catch (e) { setTimeout(() => settle(authErr(e.message || 'error')), 0); }
    return pr;
  }
  function ensureToken() {
    if (tokenOK()) return Promise.resolve(token);
    if (refreshing) return refreshing;
    if (Date.now() - lastAuthFail < 15000) return Promise.reject(authErr('sesion_vencida'));
    return requestToken('').catch(e => { lastAuthFail = Date.now(); showAuthBar(true); throw e; });
  }
  function setToken(t, secs, resp) {
    token = t; tokenExp = Date.now() + (secs - 60) * 1000;
    if (resp) {
      const g = google.accounts.oauth2;
      cloudOK = WANT_CLOUD && !!(g.hasGrantedAllScopes && g.hasGrantedAllScopes(resp, APPDATA_SCOPE));
    }
    store.set('token', { t: token, exp: tokenExp, v: SCOPE_V, cloud: cloudOK });
  }
  function onRenewed() {
    showAuthBar(false);
    if (libraryStale) { libraryStale = false; loadLibrary(false); }
    if (resumeQueue) { resumeQueue = false; loadCurrent(); }
    initUser().then(syncPull);
  }
  // Un toque en la app renueva el permiso si le quedan menos de 10 minutos (o ya venció)
  let lastGesture = 0;
  function renewOnGesture() {
    if (!started || refreshing) return;
    if (tokenOK() && Date.now() < tokenExp - 10 * 60000) return;
    if (Date.now() - lastGesture < 45000) return;
    lastGesture = Date.now();
    requestToken('').catch(() => {});                  // si falla, el aviso sigue visible
  }

  function initAuth() {
    if (!window.google || !google.accounts) { setTimeout(initAuth, 100); return; }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: SCOPE,
      callback: resp => {
        if (resp.error) { settle(authErr(resp.error)); return; }
        setToken(resp.access_token, resp.expires_in, resp);
        store.set('signedIn', true);
        lastAuthFail = 0;
        settle(null, token);
        if (!started) start(); else onRenewed();
      },
      error_callback: err => settle(authErr((err && err.type) || 'popup_error'))
    });
    const saved = store.get('token', null);
    if (saved && saved.v === SCOPE_V && saved.exp > Date.now()) { token = saved.t; tokenExp = saved.exp; cloudOK = !!saved.cloud; }
    // Si ya habías entrado antes, abre la app directo (con tu biblioteca guardada).
    if (store.get('signedIn', false)) { start(); if (!tokenOK()) showAuthBar(true); }
  }
  function showLogin() { $('login').hidden = false; $('app').hidden = true; }

  async function driveFetch(url, extra, init) {
    const go = t => fetch(url, { ...(init || {}), headers: { Authorization: 'Bearer ' + t, ...(extra || {}) } });
    let r = await go(await ensureToken());
    if (r.status === 401) { token = null; r = await go(await ensureToken()); }
    if (!r.ok) { const e = new Error('Drive respondió ' + r.status); e.status = r.status; throw e; }
    return r;
  }

  // Quién eres (para sugerirle a Google tu cuenta al renovar y separar las listas por persona)
  function initUser() {
    if (userP) return userP;
    userP = (async () => {
      try {
        const r = await (await driveFetch(`${API}/about?fields=user(emailAddress,permissionId)`)).json();
        const u = r.user || {};
        if (u.emailAddress) { loginHint = u.emailAddress; store.set('hint', loginHint); }
        currentUid = u.permissionId || '';
      } catch { userP = null; }                         // se reintenta en la próxima renovación
      return currentUid;
    })();
    return userP;
  }

  // ---------- Listas y favoritas guardadas en tu cuenta de Google ----------
  // Se guardan en la carpeta oculta de la app dentro del Drive de CADA persona
  // (no ocupan espacio visible y nadie más las ve). Así no se pierden al cambiar de celular.
  const DATA_NAME = 'mi-musica-datos.json';
  function clean(d) {
    return {
      favs: Array.isArray(d && d.favs) ? d.favs : [],
      lists: d && d.lists && typeof d.lists === 'object' ? d.lists : {},
      updated: (d && d.updated) || 0
    };
  }
  function hasContent(d) { return !!(d && ((d.favs && d.favs.length) || Object.keys(d.lists || {}).length)); }
  function mergeUnion(a, b) {
    const lists = { ...b.lists };
    for (const [n, ids] of Object.entries(a.lists)) lists[n] = [...new Set([...(lists[n] || []), ...ids])];
    return { favs: [...new Set([...a.favs, ...b.favs])], lists, updated: 0 };
  }
  function saveData() {
    data.updated = Date.now(); store.set('data', data);
    pushPending = true; schedulePush();
  }
  function schedulePush(ms) {
    if (!cloudOK) return;
    clearTimeout(pushTimer); pushTimer = setTimeout(() => pushNow().catch(() => {}), ms || 1500);
  }
  async function findDataFile() {
    if (dataFileId) return dataFileId;
    const q = encodeURIComponent(`name='${DATA_NAME}' and trashed=false`);
    const r = await (await driveFetch(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id)&pageSize=1`)).json();
    dataFileId = r.files[0] ? r.files[0].id : null;
    store.set('dataFileId', dataFileId);
    return dataFileId;
  }
  async function pushNow() {
    if (!cloudOK) return;
    clearTimeout(pushTimer);
    const body = JSON.stringify({ v: 1, favs: data.favs, lists: data.lists, updated: data.updated });
    let id = await findDataFile();
    if (id) {
      try {
        await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { 'Content-Type': 'application/json' }, { method: 'PATCH', body });
      } catch (e) {
        if (e.status === 404) { dataFileId = null; store.set('dataFileId', null); id = null; } else throw e;
      }
    }
    if (!id) {
      const b = 'mm' + Math.random().toString(36).slice(2);
      const multipart = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: DATA_NAME, parents: ['appDataFolder'] })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
      const r = await (await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { 'Content-Type': 'multipart/related; boundary=' + b }, { method: 'POST', body: multipart })).json();
      dataFileId = r.id; store.set('dataFileId', dataFileId);
    }
    pushPending = false;
  }
  async function syncPull() {
    if (!cloudOK || syncing || !started) return;
    syncing = true; lastPull = Date.now();
    try {
      const uid = await initUser();
      if (!uid) return;
      const prevUid = store.get('syncUser', '');
      if (prevUid && prevUid !== uid) {                 // otra persona entró en este mismo celular
        data = clean(null); store.set('data', data); dataFileId = null; store.set('dataFileId', null);
        store.set('syncedOnce', false); pushPending = false; render(); updateFavBtn();
      }
      store.set('syncUser', uid);

      const id = await findDataFile();
      let cloud = clean(null);
      if (id) {
        try { cloud = clean(await (await driveFetch(`${API}/files/${id}?alt=media`)).json()); }
        catch (e) { if (e.status === 404) { dataFileId = null; store.set('dataFileId', null); } else throw e; }
      }
      const first = !store.get('syncedOnce', false);
      if (first && hasContent(data)) {                  // primera vez: junta lo de este celular con lo de la nube
        if (hasContent(cloud)) data = mergeUnion(data, cloud);
        data.updated = Date.now(); store.set('data', data); render(); updateFavBtn();
        await pushNow();
      } else if (cloud.updated > data.updated || (!hasContent(data) && hasContent(cloud))) {
        data = cloud; store.set('data', data); pushPending = false; render(); updateFavBtn();
      } else if (data.updated > cloud.updated) {
        await pushNow();
      }
      store.set('syncedOnce', true);
    } catch (e) { /* sin internet o sin sesión: se reintenta más tarde */ }
    finally { syncing = false; }
  }

  // ---------- Biblioteca ----------
  async function findFolderId(name) {
    const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false`);
    const r = await (await driveFetch(`${API}/files?q=${q}&fields=files(id)&pageSize=1`)).json();
    return r.files[0]?.id || null;
  }
  async function loadLibrary(force) {
    const cached = store.get('library', null);
    if (cached && !force) { tracks = cached; render(); }
    try {
      let folderId = (CONFIG.FOLDER_ID || '').trim() || null;
      if (!folderId && CONFIG.FOLDER_NAME) folderId = await findFolderId(CONFIG.FOLDER_NAME);
      let q = "mimeType contains 'audio/' and trashed=false";
      if (folderId) q += ` and '${folderId}' in parents`;
      let out = [], pageToken = '';
      do {
        const url = `${API}/files?q=${encodeURIComponent(q)}&pageSize=1000&orderBy=name&fields=nextPageToken,files(id,name,createdTime)` + (pageToken ? '&pageToken=' + pageToken : '');
        const r = await (await driveFetch(url)).json();
        out = out.concat(r.files); pageToken = r.nextPageToken;
      } while (pageToken);
      tracks = out.map(f => {
        const p = parseName(f.name), m = meta[f.id] || {};
        return { id: f.id, name: f.name, title: m.title || p.title, artist: m.artist || p.artist, added: f.createdTime || '' };
      });
      store.set('library', tracks);
      render();
      if (force) toast(tracks.length + ' canciones');
    } catch (e) { if (e.code === 'AUTH') libraryStale = true; else toast('Error al leer Drive: ' + e.message); }
  }

  // ---------- Iconos (dibujos sencillos propios) ----------
  const ICONS = {
    play: ['<path d="M8 5.5v13l11-6.5z"/>', 'fill'],
    pause: ['<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>', 'fill'],
    next: ['<path d="M6 6l9 6-9 6zM17 6h2v12h-2z"/>', 'fill'],
    prev: ['<path d="M18 6l-9 6 9 6zM5 6h2v12H5z"/>', 'fill'],
    shuffle: ['<path d="M3.5 7H8l8 10h4.5M3.5 17H8l2.6-3.2M13.4 10.2L16 7h4.5M18 4.6L20.5 7 18 9.4M18 14.6l2.5 2.4-2.5 2.4"/>', 'line'],
    heart: ['<path d="M12 20s-7.5-4.6-7.5-10a4.3 4.3 0 0 1 7.5-2.7A4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>', 'line'],
    home: ['<path d="M4 11l8-7 8 7v8.5a1 1 0 0 1-1 1h-4.5V14h-5v6.5H5a1 1 0 0 1-1-1z"/>', 'line'],
    search: ['<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>', 'line'],
    library: ['<path d="M5 4.5v15M10 4.5v15M15 6l4.5 13.5"/>', 'line'],
    moon: ['<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>', 'line'],
    queue: ['<path d="M4 6.5h11M4 11.5h11M4 16.5h6M16 14v6l5-3z"/>', 'line'],
    gear: ['<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2L18 18M6 18l1.8-1.8M16.2 7.8L18 6"/>', 'line'],
    refresh: ['<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>', 'line'],
    power: ['<path d="M12 3.5v8M6.6 7a8 8 0 1 0 10.8 0"/>', 'line'],
    down: ['<path d="M6 9.5l6 6 6-6"/>', 'line'],
    note: ['<path d="M9 17.5V6.5l9-2v11M9 17.5a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 9 17.5zM18 15.5a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 18 15.5z"/>', 'line']
  };
  const svg = n => `<svg viewBox="0 0 24 24" class="ico ${ICONS[n][1]}" aria-hidden="true">${ICONS[n][0]}</svg>`;
  const paintIcons = () => document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = svg(el.dataset.icon); });

  // ---------- Portadas de relleno: un color distinto por canción ----------
  const hueOf = s => { let h = 7; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
  function coverHTML(t, cls) {
    const u = coverUrl(t.id, false);
    if (u) return `<img class="cv ${cls || ''}" src="${u}" alt="">`;
    const h = hueOf(t.title + t.artist);
    return `<div class="cv ph ${cls || ''}" style="--h:${h};--h2:${(h + 40) % 360}">${esc((t.title || '♪').trim().charAt(0).toUpperCase())}</div>`;
  }
  function phDataUrl(t) {
    const h = hueOf(t.title + t.artist), h2 = (h + 40) % 360;
    const ch = esc((t.title || '♪').trim().charAt(0).toUpperCase());
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},62%,46%)"/><stop offset="1" stop-color="hsl(${h2},66%,28%)"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><text x="200" y="262" font-size="190" font-family="sans-serif" font-weight="800" text-anchor="middle" fill="rgba(255,255,255,.85)">${ch}</text></svg>`);
  }

  // ---------- Pantallas: Inicio, Buscar, Biblioteca ----------
  const TITLES = { search: 'Buscar', lib: 'Tu biblioteca' };
  function greeting() { const h = new Date().getHours(); return h < 5 ? 'Buenas noches' : h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'; }
  function setView(v) {
    view = v;
    ['home', 'search', 'lib'].forEach(n => { $('view' + n.charAt(0).toUpperCase() + n.slice(1)).hidden = n !== v; });
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    $('greeting').textContent = v === 'home' ? greeting() : TITLES[v];
    $('views').scrollTop = 0;
    render();
  }
  function syncTabs() { document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === tab)); }
  function render() {
    if (view === 'home') renderHome();
    else if (view === 'search') renderSearch();
    else renderLib();
  }

  function visibleTracks() {
    let list = tracks;
    if (tab === 'favs') list = data.favs.map(byId).filter(Boolean);
    if (tab === 'lists' && openList) list = (data.lists[openList] || []).map(byId).filter(Boolean);
    return list;
  }
  function searchTracks() {
    // Como en un buscador: ignora tildes y mayúsculas, y encuentra las palabras en cualquier orden
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return tracks.filter(t => { const h = fold(t.title + ' ' + t.artist); return words.every(w => h.includes(w)); });
  }
  function rowHTML(t, curId) {
    return `<div class="row${t.id === curId ? ' playing' : ''}" data-id="${t.id}">${coverHTML(t)}<div class="info"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist || 'Artista desconocido')}</div></div><button class="more icon" data-more="${t.id}">⋯</button></div>`;
  }
  function bindRows(el, ids) {
    el.querySelectorAll('.row[data-id]').forEach(r => r.onclick = e => {
      if (e.target.dataset.more) { trackMenu(e.target.dataset.more); return; }
      playQueue(ids, ids.indexOf(r.dataset.id));
    });
  }
  function shuffleAll() {
    if (!tracks.length) return;
    shuffle = true; $('btnShuffle').classList.add('on');
    const ids = tracks.map(t => t.id);
    playQueue(ids, Math.random() * ids.length | 0);
  }

  function renderHome() {
    const el = $('viewHome');
    if (!tracks.length) { el.innerHTML = '<div class="empty">Cargando tu música…</div>'; return; }
    const recent = recentIds.map(byId).filter(Boolean).slice(0, 14);
    const favs = data.favs.map(byId).filter(Boolean).slice(0, 14);
    const fresh = tracks.filter(t => t.added).sort((a, b) => b.added.localeCompare(a.added)).slice(0, 14);
    const mine = Object.keys(data.lists);
    const shelf = (title, key, items) => !items.length ? '' :
      `<div class="sh"><h2>${title}</h2></div><div class="shelf">${items.map(t =>
        `<div class="card" data-shelf="${key}" data-id="${t.id}">${coverHTML(t)}<div class="ct">${esc(t.title)}</div><div class="ca">${esc(t.artist || 'Artista desconocido')}</div></div>`).join('')}</div>`;
    let h = `<div class="hero"><div><div class="hero-t">Tu música,<br>sin anuncios</div><div class="hero-s">${tracks.length} canciones en tu Drive</div></div><button id="btnShuffleAll" class="cta">${svg('shuffle')} Mezclar todo</button></div>`;
    h += shelf('Escuchado recientemente', 'recent', recent) + shelf('Tus favoritas', 'favs', favs);
    if (mine.length) {
      h += `<div class="sh"><h2>Tus listas</h2></div><div class="shelf">${mine.map(n => {
        const hh = hueOf(n);
        return `<div class="card" data-list="${esc(n)}"><div class="cv ph" style="--h:${hh};--h2:${(hh + 40) % 360}">≡</div><div class="ct">${esc(n)}</div><div class="ca">${data.lists[n].length} canciones</div></div>`;
      }).join('')}</div>`;
    }
    h += shelf('Nuevas en tu biblioteca', 'fresh', fresh);
    el.innerHTML = h;
    const sets = { recent, favs, fresh };
    el.querySelectorAll('.card[data-id]').forEach(c => c.onclick = () => {
      const ids = sets[c.dataset.shelf].map(t => t.id);
      playQueue(ids, ids.indexOf(c.dataset.id));
    });
    el.querySelectorAll('.card[data-list]').forEach(c => c.onclick = () => { tab = 'lists'; openList = c.dataset.list; syncTabs(); setView('lib'); });
    $('btnShuffleAll').onclick = shuffleAll;
  }

  function renderSearch() {
    const chips = $('chips'), el = $('searchList');
    if (!query) {
      const count = {};
      tracks.forEach(t => { if (t.artist) count[t.artist] = (count[t.artist] || 0) + 1; });
      const top = Object.keys(count).sort((a, b) => count[b] - count[a] || a.localeCompare(b)).slice(0, 14);
      chips.innerHTML = top.map(a => `<button class="chip" data-artist="${esc(a)}">${esc(a)}</button>`).join('');
      chips.querySelectorAll('.chip').forEach(c => c.onclick = () => { $('search').value = c.dataset.artist; query = c.dataset.artist; renderSearch(); });
      el.innerHTML = `<div class="empty">${tracks.length ? 'Escribe el nombre de una canción o de un artista.<br>No importan las tildes ni las mayúsculas.' : 'Cargando tu música…'}</div>`;
      return;
    }
    chips.innerHTML = '';
    const list = searchTracks();
    if (!list.length) { el.innerHTML = '<div class="empty">No encontré nada con esa búsqueda.</div>'; return; }
    el.innerHTML = list.map(t => rowHTML(t, queue[qi])).join('');
    bindRows(el, list.map(t => t.id));
  }

  function renderLib() {
    const el = $('list'), head = $('listHead');
    head.hidden = !(tab === 'lists');
    if (tab === 'lists' && !openList) {
      head.innerHTML = '<span style="flex:1">Mis listas</span><button id="newList">+ Nueva</button>';
      $('newList').onclick = newList;
      const names = Object.keys(data.lists);
      el.innerHTML = names.length ? names.map(n => { const hh = hueOf(n); return `<div class="row" data-list="${esc(n)}"><div class="cv ph" style="--h:${hh};--h2:${(hh + 40) % 360}">≡</div><div class="info"><div class="t">${esc(n)}</div><div class="a">${data.lists[n].length} canciones</div></div></div>`; }).join('')
        : '<div class="empty">Aún no tienes listas.<br>Crea una con “+ Nueva”.</div>';
      el.querySelectorAll('[data-list]').forEach(r => r.onclick = () => { openList = r.dataset.list; render(); });
      return;
    }
    if (tab === 'lists' && openList) {
      head.innerHTML = `<button id="back">‹ Listas</button><span style="flex:1;text-align:center">${esc(openList)}</span><button id="delList">Borrar</button>`;
      $('back').onclick = () => { openList = null; render(); };
      $('delList').onclick = () => { if (confirm('¿Borrar la lista "' + openList + '"?')) { delete data.lists[openList]; saveData(); openList = null; render(); } };
    }
    const list = visibleTracks();
    if (!list.length) { el.innerHTML = `<div class="empty">${tracks.length ? 'Nada por aquí.' : 'Cargando tu música…'}</div>`; return; }
    el.innerHTML = list.map(t => rowHTML(t, queue[qi])).join('');
    bindRows(el, list.map(t => t.id));
  }

  function newList() {
    const n = (prompt('Nombre de la lista:') || '').trim();
    if (!n) return; if (!data.lists[n]) data.lists[n] = []; saveData(); render();
  }

  // Menú de una canción (los tres puntos)
  let sheetTrack = null;
  function trackMenu(id) {
    const t = byId(id); if (!t) return;
    sheetTrack = id;
    const fav = data.favs.includes(id);
    $('trackSheetTitle').textContent = t.title;
    $('trackSheetOpts').innerHTML =
      `<button data-act="fav">${fav ? 'Quitar de favoritas' : 'Añadir a favoritas'}</button>` +
      '<button data-act="list">Añadir a una lista</button>' +
      '<button data-act="next">Reproducir a continuación</button>' +
      '<button data-act="end">Añadir al final de la cola</button>';
    $('trackSheet').hidden = false;
  }
  function trackAction(act) {
    const id = sheetTrack; $('trackSheet').hidden = true; if (!id) return;
    if (act === 'fav') toggleFav(id);
    else if (act === 'list') addToList(id);
    else if (act === 'next' || act === 'end') {
      if (qi < 0 || !queue.length) { playQueue([id], 0); return; }
      if (act === 'next') queue.splice(qi + 1, 0, id); else queue.push(id);
      toast(act === 'next' ? 'Sonará a continuación' : 'Añadida al final de la cola');
      prefetchNext();
      if (!$('queueSheet').hidden) renderQueue();
    }
  }
  function addToList(id) {
    const names = Object.keys(data.lists);
    let name;
    if (!names.length) { name = (prompt('Aún no tienes listas. Nombre de la nueva lista:') || '').trim(); }
    else {
      const c = prompt(names.map((n, i) => (i + 1) + ') ' + n).join('\n') + '\n\nEscribe el número, o un nombre nuevo:');
      if (!c) return;
      name = names[parseInt(c) - 1] || c.trim();
    }
    if (!name) return;
    data.lists[name] = data.lists[name] || [];
    if (!data.lists[name].includes(id)) data.lists[name].push(id);
    saveData(); toast('Añadida a "' + name + '"'); render();
  }
  function toggleFav(id) {
    const i = data.favs.indexOf(id);
    if (i >= 0) data.favs.splice(i, 1); else data.favs.push(id);
    saveData(); updateFavBtn(); render();
  }

  // ---------- Reproducción ----------
  function fetchBlob(id) {
    if (!cache.has(id)) {
      const p = driveFetch(`${API}/files/${id}?alt=media`).then(r => r.blob());
      p.catch(() => cache.delete(id));
      cache.set(id, p);
      if (cache.size > 5) cache.delete(cache.keys().next().value);
    }
    return cache.get(id);
  }
  function playQueue(ids, index) {
    queue = ids.slice(); qi = index;
    if (shuffle) { const c = queue[qi]; queue = shuffled(queue.filter(x => x !== c)); queue.unshift(c); qi = 0; }
    loadCurrent();
  }
  function shuffled(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }

  async function loadCurrent() {
    const id = queue[qi], t = byId(id); if (!t) return;
    showPlayer(t, null);
    try {
      const blob = await fetchBlob(id);
      if (queue[qi] !== id) return;                       // el usuario cambió de canción mientras cargaba
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = URL.createObjectURL(blob);
      audio.src = currentUrl;
      await audio.play().catch(() => {});
      readTags(blob, t);
      pushRecent(id);
      prefetchNext();
    } catch (e) {
      if (e.code === 'AUTH') { resumeQueue = true; showAuthBar(true); toast('Toca “Renovar sesión” para seguir'); }
      else toast('No se pudo cargar: ' + e.message);
    }
    render();
  }
  // Precarga las próximas 3 canciones: así la música sigue aunque la sesión de Google
  // caduque con la pantalla apagada.
  function prefetchNext() {
    for (let k = 1; k <= 3 && k < queue.length; k++) {
      fetchBlob(queue[(qi + k) % queue.length]).catch(() => {});
    }
  }
  function next() {
    if (!queue.length) return;
    qi = (qi + 1) % queue.length;
    loadCurrent();
  }
  function prev() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    qi = (qi - 1 + queue.length) % queue.length; loadCurrent();
  }

  // ---------- Etiquetas ID3: título, artista y carátula ----------
  function parseTags(blob) {
    return new Promise(res => {
      if (!window.jsmediatags) return res(null);
      try { window.jsmediatags.read(blob, { onSuccess: x => res(x.tags || null), onError: () => res(null) }); } catch { res(null); }
    });
  }
  function applyTextTags(t, tg) {
    if (!(tg.title || tg.artist)) return;
    t.title = tg.title || t.title; t.artist = tg.artist || t.artist;
    meta[t.id] = { title: t.title, artist: t.artist };
    store.set('meta', meta);
  }
  async function readTags(blob, t) {
    const tg = await parseTags(blob);
    if (tg) { applyTextTags(t, tg); store.set('library', tracks); }
    let cover = null;
    if (tg && tg.picture) {
      const b = new Blob([new Uint8Array(tg.picture.data)], { type: tg.picture.format || 'image/jpeg' });
      cover = URL.createObjectURL(b);
      saveThumb(t.id, b).then(ok => ok && render());   // queda guardada para mostrarla en la lista
    }
    if (currentCover) URL.revokeObjectURL(currentCover);
    currentCover = cover;
    if (queue[qi] === t.id) showPlayer(t, cover);
    render();
    // Si el archivo no trae portada, la busca en internet
    if (!cover) ensureOnlineCover(t).then(ok => { if (ok) { if (queue[qi] === t.id) showPlayer(t, null); render(); } });
  }

  // ---------- Carátulas desde internet (iTunes, gratis y sin cuenta) ----------
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\b(feat|ft|featuring)\b.*$/, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  function jsonp(url) {
    return new Promise((res, rej) => {
      const cb = '_jp' + Date.now() + Math.random().toString(36).slice(2);
      const s = document.createElement('script');
      let tm;
      const done = (v, e) => { clearTimeout(tm); delete window[cb]; s.remove(); e ? rej(e) : res(v); };
      tm = setTimeout(() => done(null, new Error('timeout')), 8000);
      window[cb] = v => done(v);
      s.onerror = () => done(null, new Error('error'));
      s.src = url + '&callback=' + cb;
      document.head.appendChild(s);
    });
  }
  async function findOnlineCover(t) {
    const title = norm(t.title), artist = norm(t.artist);
    if (!title) return null;
    const term = encodeURIComponent(((t.artist ? t.artist + ' ' : '') + t.title).replace(/\(.*?\)|\[.*?\]/g, ' '));
    const r = await jsonp(`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=8`);
    for (const x of (r && r.results) || []) {
      const rt = norm(x.trackName), ra = norm(x.artistName);
      if (!rt || !x.artworkUrl100) continue;
      const okTitle = artist ? (rt === title || rt.includes(title) || title.includes(rt)) : rt === title;
      const okArtist = !artist || (ra && (ra.includes(artist) || artist.includes(ra)));
      if (okTitle && okArtist) return x.artworkUrl100;
    }
    return null;
  }
  async function ensureOnlineCover(t) {
    if (thumbs.has(t.id) || onlineCovers[t.id] || noOnline.has(t.id)) return false;
    try {
      const u = await findOnlineCover(t);
      if (u) { onlineCovers[t.id] = u; store.set('onlineCovers', onlineCovers); return true; }
      noOnline.add(t.id); store.set('noOnline', [...noOnline]); return false;
    } catch { return false; }          // error de red: no se marca, se reintenta otro día
  }
  function coverUrl(id, big) {
    if (thumbs.has(id)) return thumbs.get(id);
    const u = onlineCovers[id]; if (!u) return null;
    return big ? u.replace('100x100bb', '600x600bb') : u;
  }

  // Busca las carátulas de toda la biblioteca (iTunes permite ~20 búsquedas por minuto)
  let scanning = false;
  async function scanCovers() {
    if (scanning) { scanning = false; return; }
    const todo = tracks.filter(t => !thumbs.has(t.id) && !onlineCovers[t.id] && !noOnline.has(t.id));
    if (!todo.length) { toast('No hay más carátulas por buscar'); return; }
    const mins = Math.ceil(todo.length * 3.2 / 60);
    if (!confirm(`Se buscarán carátulas en internet para ${todo.length} canciones. Tarda unos ${mins} min y debes dejar la app abierta. ¿Continuar?`)) return;
    scanning = true; $('btnScan').textContent = 'Detener búsqueda';
    let n = 0, found = 0;
    for (const t of todo) {
      if (!scanning) break;
      const t0 = Date.now();
      if (await ensureOnlineCover(t)) found++;
      n++;
      if (n % 5 === 0) { toast(`Carátulas: ${n}/${todo.length} (${found} encontradas)`); render(); }
      const wait = 3200 - (Date.now() - t0);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
    scanning = false; $('btnScan').textContent = 'Buscar carátulas de toda la biblioteca';
    render(); toast(`Listo: ${found} carátulas encontradas`);
  }

  // ---------- Interfaz del reproductor ----------
  function showPlayer(t, cover) {
    $('mini').hidden = false;
    $('miniTitle').textContent = $('fullTitle').textContent = t.title;
    $('miniArtist').textContent = $('fullArtist').textContent = t.artist || 'Artista desconocido';
    const c = cover || coverUrl(t.id, true);
    $('miniCover').src = $('fullCover').src = c || phDataUrl(t);
    updateFavBtn(); updateMediaSession(t, c); applyTint(t, c);
    if (!$('queueSheet').hidden) renderQueue();
  }
  function updateFavBtn() {
    const id = queue[qi], on = id && data.favs.includes(id);
    $('btnFav').classList.toggle('on', !!on);
  }
  function setPlayIcons() {
    $('btnPlay').innerHTML = $('miniPlay').innerHTML = svg(audio.paused ? 'play' : 'pause');
  }

  // Color de fondo del reproductor según la carátula
  async function applyTint(t, cover) {
    const full = $('full');
    full.style.setProperty('--tint', `hsl(${hueOf(t.title + t.artist)} 50% 30%)`);
    if (!cover) return;
    try {
      const img = new Image(); img.crossOrigin = 'anonymous'; img.src = cover; await img.decode();
      const c = document.createElement('canvas'); c.width = c.height = 8;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 8, 8);
      const d = g.getImageData(0, 0, 8, 8).data; let r = 0, gr = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; n++; }
      if (queue[qi] === t.id) full.style.setProperty('--tint', `rgb(${(r / n * .62) | 0} ${(gr / n * .62) | 0} ${(b / n * .62) | 0})`);
    } catch { /* portada de otra página: se queda el color de relleno */ }
  }

  // Escuchado recientemente
  function pushRecent(id) {
    recentIds = [id, ...recentIds.filter(x => x !== id)].slice(0, 30);
    store.set('recent', recentIds);
    if (view === 'home') render();
  }

  // Cola de reproducción
  const qrow = (t, i, now) => `<div class="qrow${now ? ' now' : ''}">${coverHTML(t)}<div class="qt"${now ? '' : ` data-jump="${i}"`}><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist || 'Artista desconocido')}</div></div>${now ? '' : `<button class="qb" data-up="${i}" title="Subir">↑</button><button class="qb" data-down="${i}" title="Bajar">↓</button><button class="qb" data-del="${i}" title="Quitar">✕</button>`}</div>`;
  function renderQueue() {
    const el = $('queueList');
    if (qi < 0 || !queue.length) { el.innerHTML = '<div class="empty small">No hay nada en la cola.</div>'; return; }
    const cur = byId(queue[qi]);
    let h = '<div class="qsec">Sonando ahora</div>' + (cur ? qrow(cur, qi, true) : '') + '<div class="qsec">A continuación</div>';
    const rest = queue.map((id, i) => i).filter(i => i > qi && byId(queue[i]));
    h += rest.length ? rest.map(i => qrow(byId(queue[i]), i, false)).join('') : '<div class="empty small">Es la última canción. Al terminar vuelve al principio.</div>';
    el.innerHTML = h;
    el.querySelectorAll('[data-jump]').forEach(x => x.onclick = () => { qi = +x.dataset.jump; loadCurrent(); });
    el.querySelectorAll('[data-up]').forEach(x => x.onclick = () => moveQueue(+x.dataset.up, -1));
    el.querySelectorAll('[data-down]').forEach(x => x.onclick = () => moveQueue(+x.dataset.down, 1));
    el.querySelectorAll('[data-del]').forEach(x => x.onclick = () => { queue.splice(+x.dataset.del, 1); prefetchNext(); renderQueue(); });
  }
  function moveQueue(i, d) {
    const j = i + d;
    if (j <= qi || j >= queue.length) return;
    [queue[i], queue[j]] = [queue[j], queue[i]];
    prefetchNext(); renderQueue();
  }

  // Temporizador para dormir
  function updateSleepUI() {
    const on = !!(sleepAt || sleepAfterSong);
    $('btnSleep').classList.toggle('on', on);
    $('sleepInfo').textContent = sleepAfterSong ? 'Se detendrá al terminar esta canción.'
      : sleepAt ? `Se detendrá en ${Math.max(1, Math.ceil((sleepAt - Date.now()) / 60000))} min.` : 'Desactivado.';
    document.querySelectorAll('#sleepSheet [data-sleep]').forEach(b => {
      const v = b.dataset.sleep;
      b.classList.toggle('on', (v === 'end' && sleepAfterSong) || (!!sleepAt && v === String(sleepMinutes)));
    });
  }
  function setSleep(v) {
    sleepAt = 0; sleepAfterSong = false; sleepMinutes = 0;
    if (v === 'end') sleepAfterSong = true;
    else if (v !== 'off') { sleepMinutes = +v; sleepAt = Date.now() + sleepMinutes * 60000; }
    updateSleepUI();
    toast(v === 'off' ? 'Temporizador desactivado' : v === 'end' ? 'Se detendrá al terminar la canción' : `Se detendrá en ${v} minutos`);
  }
  setInterval(() => {
    if (sleepAt && Date.now() >= sleepAt) {
      sleepAt = 0; sleepMinutes = 0; audio.pause(); updateSleepUI(); toast('Música detenida. ¡Buenas noches!');
    }
  }, 2000);

  // Controles de la pantalla de bloqueo / notificación
  function updateMediaSession(t, cover) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist || 'Mi Música', album: 'Mi Música',
      artwork: cover ? [{ src: cover, sizes: '512x512' }] : [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }]
    });
  }
  function initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
    set('play', () => audio.play());
    set('pause', () => audio.pause());
    set('previoustrack', prev);
    set('nexttrack', next);
    set('seekto', d => { audio.currentTime = d.seekTime; });
    set('seekbackward', d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
    set('seekforward', d => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
  }
  function updatePosition() {
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && isFinite(audio.duration)) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: 1, position: Math.min(audio.currentTime, audio.duration) }); } catch {}
    }
  }

  // ---------- Eventos ----------
  function bind() {
    $('btnLogin').onclick = () => {
      if (CONFIG.CLIENT_ID.startsWith('PEGA_AQUI')) { $('loginMsg').textContent = 'Falta configurar tu Client ID en config.js (mira el README).'; return; }
      $('loginMsg').textContent = '';
      // si Google aún está cargando (internet lento), espera unos segundos antes de rendirse
      waitGoogle(6000).then(() => requestToken('consent')).catch(e => { $('loginMsg').textContent = authMsg(e.message); });
    };
    $('btnLogout').onclick = () => {
      if (!confirm('¿Cerrar sesión?')) return;
      if (token && window.google) google.accounts.oauth2.revoke(token, () => {});
      audio.pause(); token = null; started = false; userP = null; cloudOK = false; showAuthBar(false);
      store.set('token', null); store.set('signedIn', false);
      $('mini').hidden = true; $('full').hidden = true; showLogin();
    };
    $('btnRefresh').onclick = () => loadLibrary(true);
    $('btnRenew').onclick = () => requestToken('').catch(() => toast('No se pudo renovar. Inténtalo de nuevo.'));
    document.addEventListener('click', renewOnGesture, true);
    document.addEventListener('visibilitychange', () => {
      if (!started) return;
      if (document.visibilityState === 'visible') {
        if (!tokenOK()) showAuthBar(true);
        if (Date.now() - lastPull > 120000) initUser().then(syncPull);
      } else if (pushPending && cloudOK) pushNow().catch(() => {});
    });
    window.addEventListener('online', () => { if (pushPending) schedulePush(500); });
    $('search').oninput = e => { query = e.target.value.trim(); renderSearch(); };
    document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; openList = null; syncTabs(); render(); });
    document.querySelectorAll('#nav button').forEach(b => b.onclick = () => setView(b.dataset.view));
    $('btnQueue').onclick = () => { renderQueue(); $('queueSheet').hidden = false; };
    $('btnCloseQueue').onclick = () => $('queueSheet').hidden = true;
    $('queueSheet').onclick = e => { if (e.target === $('queueSheet')) $('queueSheet').hidden = true; };
    $('btnSleep').onclick = () => { updateSleepUI(); $('sleepSheet').hidden = false; };
    $('btnCloseSleep').onclick = () => $('sleepSheet').hidden = true;
    $('sleepSheet').onclick = e => { if (e.target === $('sleepSheet')) $('sleepSheet').hidden = true; };
    document.querySelectorAll('#sleepSheet [data-sleep]').forEach(b => b.onclick = () => { setSleep(b.dataset.sleep); $('sleepSheet').hidden = true; });
    $('trackSheet').onclick = e => { const a = e.target.dataset && e.target.dataset.act; if (a) trackAction(a); else if (e.target === $('trackSheet') || e.target.id === 'btnCloseTrack') $('trackSheet').hidden = true; };
    $('btnShuffle').classList.toggle('on', shuffle);
    const toggle = () => audio.paused ? audio.play() : audio.pause();
    $('btnPlay').onclick = $('miniPlay').onclick = e => { e.stopPropagation(); toggle(); };
    $('btnNext').onclick = $('miniNext').onclick = e => { e.stopPropagation(); next(); };
    $('btnPrev').onclick = prev;
    $('btnShuffle').onclick = () => {
      shuffle = !shuffle; $('btnShuffle').classList.toggle('on', shuffle);
      if (queue.length) { const c = queue[qi]; queue = shuffle ? [c, ...shuffled(queue.filter(x => x !== c))] : visibleTracks().map(t => t.id); qi = Math.max(0, queue.indexOf(c)); }
      toast(shuffle ? 'Aleatorio activado' : 'Aleatorio desactivado');
    };
    $('btnFav').onclick = () => queue[qi] && toggleFav(queue[qi]);
    $('btnAddList').onclick = () => queue[qi] && addToList(queue[qi]);
    $('mini').onclick = () => $('full').hidden = false;
    $('btnClose').onclick = () => $('full').hidden = true;
    $('seek').oninput = e => { if (isFinite(audio.duration)) audio.currentTime = e.target.value / 1000 * audio.duration; };

    // Ajustes
    $('btnSettings').onclick = () => {
      $('syncState').textContent = cloudOK ? '☁ Tus listas y favoritas se guardan en tu cuenta de Google.'
        : 'Tus listas y favoritas solo se guardan en este celular. Para guardarlas en tu cuenta: cierra sesión, entra de nuevo y acepta el permiso de "datos de la app".';
      $('settings').hidden = false;
    };
    $('btnCloseSettings').onclick = () => $('settings').hidden = true;
    $('settings').onclick = e => { if (e.target === $('settings')) $('settings').hidden = true; };
    $('btnScan').onclick = scanCovers;

    audio.onplay = audio.onpause = () => { setPlayIcons(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'; };
    audio.onended = () => { if (sleepAfterSong) { sleepAfterSong = false; updateSleepUI(); toast('Música detenida. ¡Buenas noches!'); return; } next(); };
    audio.onerror = () => { if (!audio.getAttribute('src')) return; toast('Error al reproducir, pasando a la siguiente…'); setTimeout(next, 800); };
    audio.ontimeupdate = () => {
      const d = audio.duration, c = audio.currentTime;
      if (isFinite(d) && d > 0) {
        $('seek').value = c / d * 1000; $('miniBar').style.width = (c / d * 100) + '%';
        $('tCur').textContent = fmt(c); $('tDur').textContent = fmt(d);
      }
    };
    audio.onloadedmetadata = updatePosition;
    audio.onseeked = updatePosition;
  }

  // ---------- Arranque ----------
  function start() {
    started = true;
    $('login').hidden = true; $('app').hidden = false;
    setView('home');
    loadLibrary(false);
    initUser().then(syncPull);
  }
  paintIcons(); setPlayIcons();
  bind(); initMediaSession();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  initAuth();
})();
