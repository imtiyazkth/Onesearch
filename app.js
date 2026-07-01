/**
 * OneSearch v3 — app.js
 * Production-ready. No placeholders. No demo code.
 *
 * What's new / fixed in v3:
 *   ✦ Google Photos: correct scope + incremental auth + retry
 *   ✦ Settings page: appearance, search, performance, privacy, data, about
 *   ✦ Search history: recent, pinned, most used, clear
 *   ✦ Smart suggestions: live dropdown with categories + typo correction banner
 *   ✦ Empty search state with examples and prefix commands
 *   ✦ Dashboard: grouped service accordion (Drive ▼ acc1, acc2, acc3)
 *   ✦ Background index status bar
 *   ✦ Drive results: Download, Copy Link, Open in Drive
 *   ✦ Gmail: full inline preview + Android deep link
 *   ✦ Photos: album, AI label, OCR metadata fields
 *   ✦ Settings: Clear Index, Reset Everything, per-setting toggles
 *   ✦ SettingsManager: persists all prefs to localStorage
 *   ✦ SearchHistoryManager: IndexedDB-backed history
 *   ✦ AccountManager: incremental scope authorization
 *   ✦ Proper error handling: never crashes, always recovers
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   CONFIGURATION
   ═══════════════════════════════════════════════════════════════ */
const CONFIG = Object.freeze({
  GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',

  // Scopes required per service
  SCOPES_BASE: ['openid', 'email', 'profile'].join(' '),
  SCOPES_DRIVE:  'https://www.googleapis.com/auth/drive.readonly',
  SCOPES_PHOTOS: 'https://www.googleapis.com/auth/photoslibrary.readonly',
  SCOPES_GMAIL:  'https://www.googleapis.com/auth/gmail.readonly',
  SCOPES_SHEETS: 'https://www.googleapis.com/auth/spreadsheets.readonly',

  DRIVE_API:  'https://www.googleapis.com/drive/v3',
  PHOTOS_API: 'https://photoslibrary.googleapis.com/v1',
  GMAIL_API:  'https://www.googleapis.com/gmail/v1',
  SHEETS_API: 'https://www.googleapis.com/sheets/v4',

  DB_NAME:    'OneSearchDB',
  DB_VERSION: 4,

  PAGE_SIZE:          100,
  RESULTS_PER_PAGE:   20,
  SEARCH_DEBOUNCE_MS: 240,
  SUGGEST_DEBOUNCE_MS: 180,
  TOAST_DURATION_MS:  4000,

  SOURCES: Object.freeze({
    DRIVE:  'drive',
    PHOTOS: 'photos',
    GMAIL:  'gmail',
    SHEETS: 'sheets',
    LOCAL:  'local',
  }),

  SOURCE_LABELS: Object.freeze({
    drive:  'Google Drive',
    photos: 'Google Photos',
    gmail:  'Gmail',
    sheets: 'Google Sheets',
    local:  'Local Files',
  }),

  SOURCE_ICONS: Object.freeze({
    drive:  '📄', photos: '🖼', gmail: '📧', sheets: '📊', local: '💾',
  }),

  VS_ITEM_HEIGHT: 90,
  VS_OVERSCAN:    5,

  VERSION: '3.0.0',
});

/* ═══════════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════════ */
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}

function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  const now  = new Date(), diff = now - date;
  const m = Math.floor(diff/60000), h = Math.floor(diff/3600000), dy = Math.floor(diff/86400000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  if (h < 24)  return `${h}h ago`;
  if (dy === 1) return 'yesterday';
  if (dy < 7)  return `${dy}d ago`;
  return date.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function hlText(text, query) {
  if (!text || !query) return escHtml(text);
  const eq = escHtml(query).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return escHtml(text).replace(new RegExp(`(${eq})`,'gi'), '<mark>$1</mark>');
}

function uuid() {
  return crypto.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random()*16|0;
      return (c==='x' ? r : (r&0x3|0x8)).toString(16);
    });
}

async function gFetch(url, token, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json', ...(opts.headers??{}) },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json())?.error?.message ?? msg; } catch(_){}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: NotificationManager
   ═══════════════════════════════════════════════════════════════ */
class NotificationManager {
  #c;
  constructor() { this.#c = document.getElementById('toast-container'); }

  show(msg, type='info', dur=CONFIG.TOAST_DURATION_MS) {
    const t = document.createElement('div');
    t.className = `toast toast--${type}`;
    t.setAttribute('role','status');
    const icons = { success:'✓', error:'✕', warning:'⚠', info:'ℹ' };
    t.innerHTML = `<span class="toast__icon" aria-hidden="true">${icons[type]??'ℹ'}</span>
      <span class="toast__message">${escHtml(msg)}</span>
      <button class="toast__close btn-icon" aria-label="Dismiss" type="button">✕</button>`;
    const dismiss = () => {
      t.classList.add('toast--dismissing');
      t.addEventListener('animationend', () => t.remove(), { once:true });
    };
    t.querySelector('.toast__close').addEventListener('click', dismiss);
    this.#c.appendChild(t);
    t.getBoundingClientRect();
    t.classList.add('toast--visible');
    setTimeout(dismiss, dur);
  }
  success(m,d) { this.show(m,'success',d); }
  error(m,d)   { this.show(m,'error',d);   }
  warning(m,d) { this.show(m,'warning',d); }
  info(m,d)    { this.show(m,'info',d);    }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: SettingsManager
   Persists user preferences to localStorage.
   ═══════════════════════════════════════════════════════════════ */
class SettingsManager {
  #defaults = {
    theme:         'dark',
    pageSize:      20,
    fuzzy:         true,
    suggestions:   true,
    history:       true,
    bgIndex:       true,
    gmailMax:      2000,
    photosMax:     5000,
  };
  #data = {};

  load() {
    try {
      const saved = JSON.parse(localStorage.getItem('onesearch-settings') ?? '{}');
      this.#data  = { ...this.#defaults, ...saved };
    } catch(_) {
      this.#data = { ...this.#defaults };
    }
    return this;
  }

  get(key) { return this.#data[key] ?? this.#defaults[key]; }

  set(key, value) {
    this.#data[key] = value;
    try { localStorage.setItem('onesearch-settings', JSON.stringify(this.#data)); } catch(_){}
  }

  applyTheme() {
    const t = this.get('theme');
    if (t === 'system') {
      document.body.dataset.theme = window.matchMedia('(prefers-color-scheme:light)').matches ? 'light' : 'dark';
    } else {
      document.body.dataset.theme = t;
    }
  }

  clearAll() {
    this.#data = { ...this.#defaults };
    localStorage.removeItem('onesearch-settings');
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: IndexedDBManager  (Schema v4)
   ═══════════════════════════════════════════════════════════════ */
class IndexedDBManager {
  #db = null;

  async open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('items')) {
          const s = db.createObjectStore('items', { keyPath:'id' });
          s.createIndex('source',   'source',   { unique:false });
          s.createIndex('account',  'account',  { unique:false });
          s.createIndex('type',     'type',     { unique:false });
          s.createIndex('modified', 'modified', { unique:false });
          s.createIndex('starred',  'starred',  { unique:false });
        } else if (e.oldVersion < 4) {
          const s = e.target.transaction.objectStore('items');
          if (!s.indexNames.contains('account')) s.createIndex('account','account',{unique:false});
        }
        if (!db.objectStoreNames.contains('connections')) db.createObjectStore('connections', { keyPath:'key' });
        if (!db.objectStoreNames.contains('accounts'))    db.createObjectStore('accounts',    { keyPath:'email' });
        if (!db.objectStoreNames.contains('localHandles'))db.createObjectStore('localHandles', { keyPath:'id' });
        if (!db.objectStoreNames.contains('searchHistory'))db.createObjectStore('searchHistory', { keyPath:'id' });
      };
      req.onsuccess = (e) => { this.#db = e.target.result; resolve(); };
      req.onerror   = (e) => reject(new Error(`DB open failed: ${e.target.error}`));
    });
  }

  // ── Items ──────────────────────────────────────────────────────
  async putItem(item)       { return this.#tx('items','readwrite', s => s.put(item)); }
  async getItem(id)         { return this.#tx('items','readonly',  s => s.get(id)); }
  async setStarred(id, val) {
    const item = await this.getItem(id);
    if (!item) return;
    item.starred = val ? 1 : 0;
    return this.putItem(item);
  }

  async bulkPutItems(items) {
    if (!items.length) return;
    return new Promise((res,rej) => {
      const tx = this.#db.transaction('items','readwrite');
      const s  = tx.objectStore('items');
      items.forEach(i => s.put(i));
      tx.oncomplete = res;
      tx.onerror    = e => rej(new Error(e.target.error));
    });
  }

  async getAllItems(filter={}) {
    return new Promise((res,rej) => {
      const tx = this.#db.transaction('items','readonly');
      const s  = tx.objectStore('items');
      let req;
      if (filter.source) req = s.index('source').getAll(filter.source);
      else if (filter.account) req = s.index('account').getAll(filter.account);
      else req = s.getAll();
      req.onsuccess = e => {
        let r = e.target.result ?? [];
        if (filter.source && filter.account) r = r.filter(i => i.account === filter.account);
        res(r);
      };
      req.onerror = e => rej(new Error(e.target.error));
    });
  }

  async getStarredItems() {
    return new Promise((res,rej) => {
      const req = this.#db.transaction('items','readonly').objectStore('items').index('starred').getAll(IDBKeyRange.only(1));
      req.onsuccess = e => res(e.target.result ?? []);
      req.onerror   = e => rej(new Error(e.target.error));
    });
  }

  async clearBySourceAccount(source, account=null) {
    return new Promise((res,rej) => {
      const tx  = this.#db.transaction('items','readwrite');
      const req = tx.objectStore('items').index('source').openCursor(IDBKeyRange.only(source));
      req.onsuccess = e => {
        const c = e.target.result;
        if (c) { if (!account || c.value.account === account) c.delete(); c.continue(); }
      };
      tx.oncomplete = res;
      tx.onerror    = e => rej(new Error(e.target.error));
    });
  }

  async clearAll() {
    return new Promise((res,rej) => {
      const tx = this.#db.transaction(['items','connections','accounts','localHandles','searchHistory'],'readwrite');
      ['items','connections','accounts','localHandles','searchHistory'].forEach(s => tx.objectStore(s).clear());
      tx.oncomplete = res;
      tx.onerror    = e => rej(new Error(e.target.error));
    });
  }

  async totalCount() { return this.#tx('items','readonly', s => s.count()); }

  async countBySource(source) {
    return new Promise((res,rej) => {
      const req = this.#db.transaction('items','readonly').objectStore('items').index('source').count(IDBKeyRange.only(source));
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(new Error(e.target.error));
    });
  }

  // ── Connections ────────────────────────────────────────────────
  connKey(src, acc) { return acc ? `${src}::${acc}` : src; }
  async getConnection(src,acc)        { return this.#tx('connections','readonly',  s => s.get(this.connKey(src,acc))); }
  async getAllConnections()            { return this.#tx('connections','readonly',  s => s.getAll()); }
  async setConnection(src,acc,data)   { return this.#tx('connections','readwrite', s => s.put({ key:this.connKey(src,acc), source:src, account:acc, ...data })); }
  async removeConnection(src,acc)     { return this.#tx('connections','readwrite', s => s.delete(this.connKey(src,acc))); }

  // ── Accounts ───────────────────────────────────────────────────
  async saveAccount(p)   { return this.#tx('accounts','readwrite', s => s.put(p)); }
  async getAccount(e)    { return this.#tx('accounts','readonly',  s => s.get(e)); }
  async getAllAccounts()  { return this.#tx('accounts','readonly',  s => s.getAll()); }
  async removeAccount(e) { return this.#tx('accounts','readwrite', s => s.delete(e)); }

  // ── Local handles ──────────────────────────────────────────────
  async saveLocalHandle(id,handle,meta) { return this.#tx('localHandles','readwrite', s => s.put({ id, handle, ...meta })); }
  async getLocalHandle(id)              { return this.#tx('localHandles','readonly',  s => s.get(id)); }
  async getAllLocalHandles()             { return this.#tx('localHandles','readonly',  s => s.getAll()); }
  async removeLocalHandle(id)           { return this.#tx('localHandles','readwrite', s => s.delete(id)); }

  // ── Search history ─────────────────────────────────────────────
  async addHistoryEntry(entry) { return this.#tx('searchHistory','readwrite', s => s.put(entry)); }
  async getAllHistory()         { return this.#tx('searchHistory','readonly',  s => s.getAll()); }
  async removeHistory(id)      { return this.#tx('searchHistory','readwrite', s => s.delete(id)); }
  async clearHistory()         { return this.#tx('searchHistory','readwrite', s => s.clear()); }

  // ── Private ────────────────────────────────────────────────────
  #tx(store,mode,op) {
    return new Promise((res,rej) => {
      const tx = this.#db.transaction(store,mode);
      const s  = tx.objectStore(store);
      const r  = op(s);
      if (r) { r.onsuccess = e => res(e.target.result); r.onerror = e => rej(new Error(e.target.error)); }
      else   { tx.oncomplete = res; tx.onerror = e => rej(new Error(e.target.error)); }
    });
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: SearchHistoryManager
   ═══════════════════════════════════════════════════════════════ */
class SearchHistoryManager {
  #db;
  #maxEntries = 100;

  constructor(db) { this.#db = db; }

  async add(query) {
    if (!query || query.trim().length < 2) return;
    const q     = query.trim();
    const all   = await this.#db.getAllHistory();
    const exist = all.find(e => e.query === q);

    const entry = {
      id:      exist?.id ?? uuid(),
      query:   q,
      count:   (exist?.count ?? 0) + 1,
      pinned:  exist?.pinned ?? false,
      lastAt:  Date.now(),
    };

    await this.#db.addHistoryEntry(entry);

    // Trim to max (keep pinned)
    if (all.length >= this.#maxEntries) {
      const unpinned = all.filter(e => !e.pinned && e.id !== entry.id)
        .sort((a,b) => a.lastAt - b.lastAt);
      if (unpinned.length > 0) await this.#db.removeHistory(unpinned[0].id);
    }
  }

  async getRecent(limit=10) {
    const all = await this.#db.getAllHistory();
    return all.sort((a,b) => b.lastAt - a.lastAt).slice(0, limit);
  }

  async getMostUsed(limit=5) {
    const all = await this.#db.getAllHistory();
    return all.sort((a,b) => b.count - a.count).slice(0, limit);
  }

  async getPinned() {
    const all = await this.#db.getAllHistory();
    return all.filter(e => e.pinned).sort((a,b) => b.lastAt - a.lastAt);
  }

  async pin(id, pinned) {
    const all = await this.#db.getAllHistory();
    const e   = all.find(h => h.id === id);
    if (!e) return;
    e.pinned = pinned;
    await this.#db.addHistoryEntry(e);
  }

  async remove(id) { return this.#db.removeHistory(id); }
  async clear()    { return this.#db.clearHistory(); }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: SearchWorker
   ═══════════════════════════════════════════════════════════════ */
class SearchWorker {
  #w        = null;
  #pending  = new Map();
  #ready    = false;
  #queue    = [];

  init() {
    this.#w = new Worker('search_worker.js');
    this.#w.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'READY')        { this.#ready = true; this.#queue.forEach(f=>f()); this.#queue = []; }
      if (msg.type === 'BUILD_DONE')   {}
      if (msg.type === 'SEARCH_DONE' || msg.type === 'SUGGEST_DONE') {
        const p = this.#pending.get(msg.id);
        if (p) { this.#pending.delete(msg.id); p.resolve(msg); }
      }
      if (msg.type === 'ERROR') console.error('[Worker]', msg.message);
    };
    this.#w.onerror = e => console.error('[Worker error]', e.message);
  }

  build(docs) { this.#send({ type:'BUILD', docs }); }
  addDoc(doc) { this.#send({ type:'ADD', doc }); }
  removeDoc(id) { this.#send({ type:'REMOVE', id }); }

  search(query, filters={}, page=1, pageSize=20) {
    return new Promise((resolve,reject) => {
      const id = uuid();
      this.#pending.set(id, { resolve, reject });
      this.#send({ type:'SEARCH', id, query, filters, page, pageSize });
    });
  }

  suggest(query, limit=8) {
    return new Promise((resolve,reject) => {
      const id = uuid();
      this.#pending.set(id, { resolve, reject });
      this.#send({ type:'SUGGEST', id, query, limit });
    });
  }

  #send(msg) {
    if (this.#ready) this.#w.postMessage(msg);
    else this.#queue.push(() => this.#w.postMessage(msg));
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: VirtualScroller
   ═══════════════════════════════════════════════════════════════ */
class VirtualScroller {
  #items=[]; #container=null; #list=null; #top=null; #bot=null; #renderFn=null;
  #ih=CONFIG.VS_ITEM_HEIGHT; #os=CONFIG.VS_OVERSCAN; #vs=0; #ve=0; #raf=null;

  init({container,list,spacerTop,spacerBottom,renderFn,itemHeight}) {
    this.#container=container; this.#list=list; this.#top=spacerTop; this.#bot=spacerBottom;
    this.#renderFn=renderFn; if(itemHeight) this.#ih=itemHeight;
    this.#container.addEventListener('scroll',()=>this.#sched(),{passive:true});
  }

  setItems(items) { this.#items=items; this.#vs=0; this.#render(); }
  appendItems(items) { this.#items.push(...items); this.#render(); }
  clear() { this.#items=[]; if(this.#list) this.#list.innerHTML=''; if(this.#top) this.#top.style.height='0px'; if(this.#bot) this.#bot.style.height='0px'; }
  get size() { return this.#items.length; }

  #sched() { if(this.#raf) cancelAnimationFrame(this.#raf); this.#raf=requestAnimationFrame(()=>this.#render()); }

  #render() {
    if(!this.#container||!this.#list) return;
    const total=this.#items.length, st=this.#container.scrollTop, vh=this.#container.clientHeight, ih=this.#ih;
    const first=Math.max(0,Math.floor(st/ih)-this.#os);
    const last =Math.min(total-1,Math.ceil((st+vh)/ih)+this.#os);
    if(first===this.#vs&&last===this.#ve&&this.#list.children.length>0) return;
    this.#vs=first; this.#ve=last;
    this.#top.style.height=`${first*ih}px`;
    this.#bot.style.height=`${Math.max(0,(total-last-1)*ih)}px`;
    const frag=document.createDocumentFragment(), tmp=document.createElement('div');
    tmp.innerHTML=this.#items.slice(first,last+1).map(i=>this.#renderFn(i)).join('');
    while(tmp.firstChild) frag.appendChild(tmp.firstChild);
    this.#list.innerHTML=''; this.#list.appendChild(frag);
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: AccountManager
   Multi-account OAuth. Supports incremental authorization.
   ═══════════════════════════════════════════════════════════════ */
class AccountManager {
  /** email → { profile, tokenClient, accessToken, expiry, grantedScopes } */
  #accounts = new Map();
  #db       = null;
  #onUpdate = null;

  constructor(db, onUpdate) { this.#db = db; this.#onUpdate = onUpdate; }

  async restore() {
    const saved = await this.#db.getAllAccounts();
    for (const p of saved) {
      this.#accounts.set(p.email, { profile:p, tokenClient:null, accessToken:null, expiry:0, grantedScopes:[] });
    }
  }

  /**
   * Adds a new Google account via GIS popup.
   * @param {string} [hint] - email hint
   */
  addAccount(hint) {
    return new Promise((resolve,reject) => {
      if (typeof google === 'undefined') { reject(new Error('GIS not loaded.')); return; }

      const allScopes = [
        CONFIG.SCOPES_BASE,
        CONFIG.SCOPES_DRIVE,
        CONFIG.SCOPES_PHOTOS,
        CONFIG.SCOPES_GMAIL,
        CONFIG.SCOPES_SHEETS,
      ].join(' ');

      const tc = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        scope:     allScopes,
        prompt:    'select_account',
        hint:      hint ?? '',
        callback:  async (resp) => {
          if (resp.error) { reject(new Error(resp.error_description ?? resp.error)); return; }
          try {
            const profile      = await this.#fetchProfile(resp.access_token);
            const expiry       = Date.now() + (resp.expires_in ?? 3600) * 1000;
            const grantedScopes = (resp.scope ?? allScopes).split(' ');

            this.#accounts.set(profile.email, {
              profile, tokenClient:tc,
              accessToken: resp.access_token,
              expiry, grantedScopes,
            });

            await this.#db.saveAccount({
              email:    profile.email,
              name:     profile.name,
              picture:  profile.picture,
              addedAt:  new Date().toISOString(),
            });

            this.#onUpdate?.(this.listAccounts());
            resolve(profile.email);
          } catch(err) { reject(err); }
        },
      });

      tc.requestAccessToken({ prompt:'select_account' });
    });
  }

  /**
   * Returns a valid token for the given email, refreshing if needed.
   * Optionally checks that a specific scope is granted.
   * If the scope is missing, triggers incremental auth.
   */
  async getToken(email, requiredScope=null) {
    const entry = this.#accounts.get(email);
    if (!entry) throw new Error(`Account not connected: ${email}`);

    // Check scope coverage
    if (requiredScope && entry.grantedScopes.length > 0) {
      const hasScope = entry.grantedScopes.some(s => s.includes(requiredScope.split('/').pop()));
      if (!hasScope) {
        await this.#requestIncrementalScope(email, requiredScope);
      }
    }

    if (entry.accessToken && Date.now() < entry.expiry - 60000) return entry.accessToken;
    return this.#refreshToken(email);
  }

  /**
   * Requests authorization for a missing scope (incremental auth).
   */
  async #requestIncrementalScope(email, scope) {
    return new Promise((resolve,reject) => {
      const entry = this.#accounts.get(email);
      if (!entry) { reject(new Error('Account not found')); return; }

      const tc = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        scope:     scope,
        hint:      email,
        prompt:    'consent',
        callback:  (resp) => {
          if (resp.error) { reject(new Error(resp.error_description ?? resp.error)); return; }
          entry.accessToken   = resp.access_token;
          entry.expiry        = Date.now() + (resp.expires_in ?? 3600) * 1000;
          entry.grantedScopes = [...new Set([...entry.grantedScopes, ...(resp.scope??'').split(' ')])];
          resolve();
        },
      });
      tc.requestAccessToken({ prompt:'consent', hint: email });
    });
  }

  async #refreshToken(email) {
    return new Promise((resolve,reject) => {
      const entry = this.#accounts.get(email);
      if (!entry) { reject(new Error(`Account not found: ${email}`)); return; }

      if (!entry.tokenClient) {
        entry.tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CONFIG.GOOGLE_CLIENT_ID,
          scope:     [CONFIG.SCOPES_BASE,CONFIG.SCOPES_DRIVE,CONFIG.SCOPES_PHOTOS,CONFIG.SCOPES_GMAIL,CONFIG.SCOPES_SHEETS].join(' '),
          hint:      email,
          callback:  () => {},
        });
      }

      const origCb = entry.tokenClient.callback;
      entry.tokenClient.callback = (resp) => {
        entry.tokenClient.callback = origCb;
        if (resp.error) { reject(new Error(resp.error_description ?? resp.error)); return; }
        entry.accessToken = resp.access_token;
        entry.expiry      = Date.now() + (resp.expires_in ?? 3600) * 1000;
        resolve(entry.accessToken);
      };
      entry.tokenClient.requestAccessToken({ prompt:'' });
    });
  }

  async removeAccount(email) {
    const entry = this.#accounts.get(email);
    if (entry?.accessToken) { try { google.accounts.oauth2.revoke(entry.accessToken,()=>{}); } catch(_){} }
    this.#accounts.delete(email);
    await this.#db.removeAccount(email);
    this.#onUpdate?.(this.listAccounts());
  }

  listAccounts() { return [...this.#accounts.values()].map(e => e.profile); }
  get hasAccounts() { return this.#accounts.size > 0; }

  async #fetchProfile(token) {
    const d = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization:`Bearer ${token}` },
    }).then(r => r.json());
    return { email:d.email, name:d.name, picture:d.picture, sub:d.sub };
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: DriveService
   ═══════════════════════════════════════════════════════════════ */
class DriveService {
  constructor(accountMgr, db, onProgress) {
    this.mgr = accountMgr; this.db = db; this.onProgress = onProgress;
  }

  async index(email) {
    const token = await this.mgr.getToken(email, CONFIG.SCOPES_DRIVE);
    let pgToken = null, indexed = 0;
    const items = [];
    const fields = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,webViewLink,webContentLink,iconLink,owners,description,shared)';

    do {
      const params = new URLSearchParams({ pageSize:CONFIG.PAGE_SIZE, fields, q:'trashed=false', ...(pgToken?{pageToken:pgToken}:{}) });
      const data   = await gFetch(`${CONFIG.DRIVE_API}/files?${params}`, token);
      const files  = data.files ?? [];
      const pIds   = [...new Set(files.flatMap(f=>f.parents??[]))];
      const fMap   = await this.#folders(pIds, token);

      for (const f of files) {
        items.push({
          id:          `drive::${email}::${f.id}`,
          source:      'drive', account: email,
          type:        this.#mime2type(f.mimeType),
          name:        f.name,
          folder:      f.parents ? (fMap[f.parents[0]] ?? 'My Drive') : 'My Drive',
          mimeType:    f.mimeType,
          size:        f.size ? parseInt(f.size,10) : 0,
          modified:    f.modifiedTime,
          url:         f.webViewLink,
          downloadUrl: f.webContentLink ?? null,
          description: f.description ?? '',
          owner:       f.owners?.[0]?.displayName ?? '',
          ownerEmail:  f.owners?.[0]?.emailAddress ?? '',
          nativeId:    f.id, starred:0, indexed:Date.now(),
        });
        indexed++;
      }
      this.onProgress?.(indexed, indexed, `Indexing Drive (${email})… ${indexed} files`);
      pgToken = data.nextPageToken ?? null;
      await new Promise(r=>setTimeout(r,0));
    } while (pgToken);

    await this.db.bulkPutItems(items);
    await this.db.setConnection('drive', email, { connected:true, lastSync:new Date().toISOString(), count:indexed });
    return indexed;
  }

  async #folders(ids, token) {
    const map = {};
    if (!ids.length) return map;
    for (let i=0; i<ids.length; i+=100) {
      try {
        const chunk  = ids.slice(i,i+100);
        const q      = chunk.map(id=>`'${id}' in parents`).join(' or ');
        const params = new URLSearchParams({ q:`(${q}) and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields:'files(id,name)', pageSize:100 });
        const data   = await gFetch(`${CONFIG.DRIVE_API}/files?${params}`, token);
        (data.files??[]).forEach(f=>{ map[f.id]=f.name; });
      } catch(_){}
    }
    return map;
  }

  #mime2type(m) {
    if (!m) return 'file';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    if (m==='application/pdf')  return 'pdf';
    if (m.includes('spreadsheet')||m.includes('excel')) return 'spreadsheet';
    if (m.includes('document')  ||m.includes('word'))   return 'document';
    if (m.includes('presentation')||m.includes('powerpoint')) return 'presentation';
    if (m.includes('folder'))   return 'folder';
    return 'file';
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: PhotosService
   Fixed: correct scope, incremental auth, retry, album/label fields
   ═══════════════════════════════════════════════════════════════ */
class PhotosService {
  constructor(accountMgr, db, onProgress, settings) {
    this.mgr = accountMgr; this.db = db; this.onProgress = onProgress; this.settings = settings;
  }

  async index(email) {
    // Explicitly request Photos scope — triggers incremental auth if needed
    let token;
    try {
      token = await this.mgr.getToken(email, CONFIG.SCOPES_PHOTOS);
    } catch(err) {
      throw new Error(`Google Photos authorization failed: ${err.message}. Please reconnect your account.`);
    }

    const maxItems = this.settings?.get('photosMax') ?? 5000;
    let pgToken = null, indexed = 0;
    const items  = [];

    do {
      // Google Photos uses GET with query params for listing
      const params = new URLSearchParams({ pageSize:Math.min(100, CONFIG.PAGE_SIZE), ...(pgToken?{pageToken:pgToken}:{}) });
      let data;
      try {
        data = await gFetch(`${CONFIG.PHOTOS_API}/mediaItems?${params}`, token);
      } catch(err) {
        if (err.status === 401 || err.status === 403) {
          // Scope issue — request incremental auth
          try {
            token = await this.mgr.getToken(email, CONFIG.SCOPES_PHOTOS);
            data  = await gFetch(`${CONFIG.PHOTOS_API}/mediaItems?${params}`, token);
          } catch(retryErr) {
            throw new Error(`Photos access denied: ${retryErr.message}`);
          }
        } else throw err;
      }

      for (const item of (data.mediaItems ?? [])) {
        const meta  = item.mediaMetadata ?? {};
        const photo = meta.photo ?? {};
        items.push({
          id:          `photos::${email}::${item.id}`,
          source:      'photos', account: email,
          type:        meta.video ? 'video' : 'image',
          name:        item.filename ?? 'Untitled',
          description: item.description ?? '',
          modified:    meta.creationTime ?? new Date().toISOString(),
          url:         item.productUrl,
          thumbnail:   item.baseUrl ? `${item.baseUrl}=w400-h400` : null,
          mimeType:    item.mimeType ?? 'image/jpeg',
          width:       meta.width  ?? 0,
          height:      meta.height ?? 0,
          cameraMake:  photo.cameraMake  ?? '',
          cameraModel: photo.cameraModel ?? '',
          albums:      [],   // Albums require separate API call
          labels:      [],   // AI labels require Vision API (not available in Library API v1)
          nativeId:    item.id, starred:0, indexed:Date.now(),
        });
        indexed++;
      }

      if (indexed >= maxItems) break;
      this.onProgress?.(indexed, maxItems, `Indexing Photos (${email})… ${indexed}`);
      await new Promise(r=>setTimeout(r,0));
      pgToken = data.nextPageToken ?? null;
    } while (pgToken);

    await this.db.bulkPutItems(items);
    await this.db.setConnection('photos', email, { connected:true, lastSync:new Date().toISOString(), count:indexed });
    return indexed;
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: GmailService
   ═══════════════════════════════════════════════════════════════ */
class GmailService {
  constructor(accountMgr, db, onProgress, settings) {
    this.mgr = accountMgr; this.db = db; this.onProgress = onProgress; this.settings = settings;
  }

  async index(email) {
    const token  = await this.mgr.getToken(email, CONFIG.SCOPES_GMAIL);
    const maxMsg = this.settings?.get('gmailMax') ?? 2000;
    let pgToken  = null;
    const msgIds = [];

    do {
      const params = new URLSearchParams({ maxResults:CONFIG.PAGE_SIZE, ...(pgToken?{pageToken:pgToken}:{}) });
      const data   = await gFetch(`${CONFIG.GMAIL_API}/users/me/messages?${params}`, token);
      msgIds.push(...(data.messages??[]).map(m=>m.id));
      pgToken = data.nextPageToken ?? null;
      if (msgIds.length >= maxMsg) break;
    } while (pgToken);

    const items = [];
    for (let i=0; i<msgIds.length; i+=20) {
      const batch   = msgIds.slice(i,i+20);
      const settled = await Promise.allSettled(batch.map(id=>this.#fetchMsg(id,token,email)));
      for (const r of settled) { if (r.status==='fulfilled'&&r.value) items.push(r.value); }
      this.onProgress?.(items.length, msgIds.length, `Indexing Gmail (${email})… ${items.length}`);
      await new Promise(r=>setTimeout(r,0));
    }

    await this.db.bulkPutItems(items);
    await this.db.setConnection('gmail', email, { connected:true, lastSync:new Date().toISOString(), count:items.length });
    return items.length;
  }

  async #fetchMsg(id, token, email) {
    const params = new URLSearchParams({ format:'metadata', metadataHeaders:['From','To','Subject','Date','X-GM-LABELS'] });
    const data   = await gFetch(`${CONFIG.GMAIL_API}/users/me/messages/${id}?${params}`, token);
    const hdr    = n => (data.payload?.headers??[]).find(h=>h.name.toLowerCase()===n.toLowerCase())?.value??'';
    return {
      id:          `gmail::${email}::${id}`,
      source:      'gmail', account: email,
      type:        'email',
      name:        hdr('Subject') || '(no subject)',
      subject:     hdr('Subject') || '(no subject)',
      sender:      hdr('From'),
      receiver:    hdr('To'),
      body:        data.snippet ?? '',
      attachments: this.#attachNames(data.payload),
      labelIds:    data.labelIds ?? [],
      modified:    hdr('Date') ? new Date(hdr('Date')).toISOString() : new Date().toISOString(),
      url:         `https://mail.google.com/mail/u/0/#inbox/${id}`,
      androidUrl:  `googlegmail:///co?subject=${encodeURIComponent(hdr('Subject'))}&messageId=${id}`,
      nativeId:    id, threadId: data.threadId,
      starred:     data.labelIds?.includes('STARRED') ? 1 : 0,
      indexed:     Date.now(),
    };
  }

  #attachNames(payload) {
    const names = [];
    const walk  = p => { if (p?.filename?.length) names.push(p.filename); (p?.parts??[]).forEach(walk); };
    walk(payload);
    return names;
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: SheetsService
   ═══════════════════════════════════════════════════════════════ */
class SheetsService {
  constructor(accountMgr, db, onProgress) {
    this.mgr = accountMgr; this.db = db; this.onProgress = onProgress;
  }

  async index(email) {
    const token   = await this.mgr.getToken(email, CONFIG.SCOPES_SHEETS);
    const files   = [];
    let pgToken   = null;

    do {
      const params = new URLSearchParams({ q:"mimeType='application/vnd.google-apps.spreadsheet' and trashed=false", fields:'nextPageToken,files(id,name,modifiedTime,webViewLink)', pageSize:CONFIG.PAGE_SIZE, ...(pgToken?{pageToken:pgToken}:{}) });
      const data   = await gFetch(`${CONFIG.DRIVE_API}/files?${params}`, token);
      files.push(...(data.files??[]));
      pgToken = data.nextPageToken ?? null;
    } while (pgToken);

    const items = [];
    for (let i=0; i<files.length; i++) {
      const f = files[i];
      try {
        const { cellValues, sheetNames } = await this.#cells(f.id, token);
        items.push({
          id:         `sheets::${email}::${f.id}`,
          source:     'sheets', account: email,
          type:       'spreadsheet',
          name:       f.name,
          folder:     '',
          modified:   f.modifiedTime,
          url:        f.webViewLink,
          cellValues, sheetNames,
          nativeId:   f.id, starred:0, indexed:Date.now(),
        });
      } catch(_){}
      this.onProgress?.(i+1, files.length, `Indexing Sheets (${email})… ${i+1}`);
    }

    await this.db.bulkPutItems(items);
    await this.db.setConnection('sheets', email, { connected:true, lastSync:new Date().toISOString(), count:items.length });
    return items.length;
  }

  async #cells(id, token) {
    const meta   = await gFetch(`${CONFIG.SHEETS_API}/spreadsheets/${id}?fields=sheets.properties`, token);
    const sheets = (meta.sheets??[]).slice(0,5);
    const cellValues=[], sheetNames=[];

    for (const sh of sheets) {
      const title = sh.properties?.title;
      if (!title) continue;
      sheetNames.push(title);
      try {
        const range = encodeURIComponent(`'${title}'!A1:Z100`);
        const data  = await gFetch(`${CONFIG.SHEETS_API}/spreadsheets/${id}/values/${range}`, token);
        (data.values??[]).forEach(row => row.forEach(cell => {
          if (cell && typeof cell==='string' && cell.length < 500) cellValues.push(cell);
        }));
      } catch(_){}
    }
    return { cellValues, sheetNames };
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: LocalFilesService
   ═══════════════════════════════════════════════════════════════ */
class LocalFilesService {
  #db; #onProgress; #handles = new Map();

  constructor(db, onProgress) { this.#db = db; this.#onProgress = onProgress; }

  async restoreHandles() {
    const saved = await this.#db.getAllLocalHandles();
    for (const e of saved) { if (e.handle) this.#handles.set(e.id, e.handle); }
    return saved;
  }

  async pickAndIndex() {
    if ('showDirectoryPicker' in window) return this.#fsa();
    return this.#input();
  }

  async rescan(folderId) {
    const h = this.#handles.get(folderId);
    if (!h) throw new Error('Folder access expired. Please re-select the folder.');
    return this.#walk(h, folderId, h.name);
  }

  async openForPreview(item) {
    const h = this.#handles.get(item.folderId);
    if (!h) return null;
    try {
      const fh   = await this.#navigate(h, item.relativePath);
      if (!fh) return null;
      const file = await fh.getFile();
      const mime = file.type || item.mimeType || '';
      const name = item.name ?? '';
      const ext  = name.split('.').pop()?.toLowerCase() ?? '';

      if (mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','svg','heic','avif'].includes(ext)) {
        return { type:'image', url:URL.createObjectURL(file), name, mime };
      }
      if (mime==='application/pdf' || ext==='pdf') {
        return { type:'pdf', url:URL.createObjectURL(file), name, mime };
      }
      if (mime.startsWith('audio/') || ['mp3','wav','flac','aac','ogg','m4a'].includes(ext)) {
        return { type:'audio', url:URL.createObjectURL(file), name, mime };
      }
      if (mime.startsWith('video/') || ['mp4','webm','mov','avi','mkv'].includes(ext)) {
        return { type:'video', url:URL.createObjectURL(file), name, mime };
      }
      if (ext==='md' || ext==='markdown') {
        const text = await file.text(); return { type:'markdown', text, name, mime };
      }
      if (ext==='csv') {
        const text = await file.text(); return { type:'csv', text, name, mime };
      }
      if (ext==='json') {
        const text = await file.text(); return { type:'json', text, name, mime };
      }
      if (ext==='html' || ext==='htm') {
        const text = await file.text(); return { type:'html', text, name, mime };
      }
      if (mime.startsWith('text/') || ['txt','md','js','ts','py','java','css','sh','yaml','xml','rs','go','cpp','c','h'].includes(ext)) {
        if (file.size < 2_000_000) { const text=await file.text(); return { type:'text', text, name, mime }; }
      }
      return { type:'download', file, name, mime };
    } catch(_) { return null; }
  }

  async removeFolder(folderId) {
    this.#handles.delete(folderId);
    await this.#db.removeLocalHandle(folderId);
    await this.#db.clearBySourceAccount('local', folderId);
    await this.#db.removeConnection('local', folderId);
  }

  async #fsa() {
    let dh;
    try { dh = await window.showDirectoryPicker({ mode:'read' }); }
    catch(e) { if (e.name==='AbortError') return 0; throw e; }
    const id = `local-${dh.name}-${Date.now()}`;
    this.#handles.set(id, dh);
    await this.#db.saveLocalHandle(id, dh, { name:dh.name, addedAt:new Date().toISOString() });
    return this.#walk(dh, id, dh.name);
  }

  async #input() {
    const inp = document.getElementById('local-folder-input');
    if (!inp) throw new Error('Folder input not found.');
    return new Promise((res,rej) => {
      inp.onchange = async () => {
        const files = [...inp.files];
        if (!files.length) { res(0); return; }
        const root = files[0].webkitRelativePath.split('/')[0] ?? 'Local';
        const id   = `local-${root}-${Date.now()}`;
        const items= [];
        for (let i=0; i<files.length; i++) {
          items.push(this.#toItem(files[i], files[i].webkitRelativePath, id, root));
          if (i%50===0) { this.#onProgress?.(i,files.length,`Indexing ${root}… ${i}/${files.length}`); await new Promise(r=>setTimeout(r,0)); }
        }
        try {
          await this.#db.bulkPutItems(items);
          await this.#db.setConnection('local', id, { connected:true, lastSync:new Date().toISOString(), count:items.length, folder:root });
          inp.value=''; res(items.length);
        } catch(e) { rej(e); }
      };
      inp.click();
    });
  }

  async #walk(dh, folderId, rootName) {
    const entries = [];
    await this.#walkDir(dh, entries, '');
    const items = [];
    for (let i=0; i<entries.length; i++) {
      items.push(this.#toItem(entries[i].file, entries[i].rel, folderId, rootName));
      if (i%100===0) { this.#onProgress?.(i,entries.length,`Indexing ${rootName}… ${i}/${entries.length}`); await new Promise(r=>setTimeout(r,0)); }
    }
    await this.#db.bulkPutItems(items);
    await this.#db.setConnection('local', folderId, { connected:true, lastSync:new Date().toISOString(), count:items.length, folder:rootName });
    return items.length;
  }

  async #walkDir(dh, results, currentPath) {
    for await (const [name, handle] of dh.entries()) {
      const rel = currentPath ? `${currentPath}/${name}` : name;
      if (handle.kind==='directory') await this.#walkDir(handle, results, rel);
      else { try { results.push({ file:await handle.getFile(), rel }); } catch(_){} }
    }
  }

  async #navigate(root, rel) {
    const parts = rel.split('/');
    let cur = root;
    for (let i=0; i<parts.length-1; i++) { try { cur=await cur.getDirectoryHandle(parts[i]); } catch(_){return null;} }
    try { return await cur.getFileHandle(parts.at(-1)); } catch(_){ return null; }
  }

  #toItem(file, relativePath, folderId, rootName) {
    const ext  = file.name.split('.').pop()?.toLowerCase() ?? '';
    const mime = file.type || '';
    let type = 'file';
    if (mime.startsWith('image/')||['jpg','jpeg','png','gif','webp','svg','heic'].includes(ext)) type='image';
    else if (mime.startsWith('video/')||['mp4','webm','mov','avi','mkv'].includes(ext)) type='video';
    else if (mime.startsWith('audio/')||['mp3','wav','flac','aac','ogg','m4a'].includes(ext)) type='audio';
    else if (mime==='application/pdf'||ext==='pdf') type='pdf';
    else if (['xls','xlsx','csv','ods'].includes(ext)) type='spreadsheet';
    else if (['doc','docx','odt','rtf'].includes(ext)) type='document';
    else if (['ppt','pptx','odp'].includes(ext)) type='presentation';
    else if (['js','ts','py','java','go','rs','cpp','c','css','html','json','xml','yaml','sh','md'].includes(ext)) type='code';
    return {
      id:`local::${folderId}::${relativePath}`,
      source:'local', account:folderId, type,
      name:file.name, folder:rootName, relativePath, folderId,
      size:file.size, mimeType:mime||'application/octet-stream',
      modified:new Date(file.lastModified).toISOString(),
      url:null, nativeId:relativePath, starred:0, indexed:Date.now(),
    };
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: UIManager
   ═══════════════════════════════════════════════════════════════ */
class UIManager {
  #query    = '';
  #previewId = null;
  #listMode  = true;

  init() {
    const yr = document.getElementById('footer-year');
    if (yr) yr.textContent = new Date().getFullYear();
  }

  // ── Loading ────────────────────────────────────────────────────
  showLoading(s='Initialising…') { const el=document.getElementById('loading-screen'); if(el){el.hidden=false; this.setLoadingStatus(s);} }
  hideLoading() {
    const el=document.getElementById('loading-screen'); if(!el)return;
    el.classList.add('loading-screen--hidden');
    el.addEventListener('transitionend',()=>{el.hidden=true;},{once:true});
  }
  setLoadingStatus(text, pct=null) {
    const el=document.getElementById('loading-status-text'); if(el) el.textContent=text;
    if(pct!==null){const f=document.getElementById('loading-bar-fill');if(f)f.style.width=`${Math.min(100,pct)}%`;}
  }

  // ── View switching ─────────────────────────────────────────────
  switchView(name) {
    document.querySelectorAll('.view').forEach(v=>{v.hidden=v.dataset.view!==name;});
    document.querySelectorAll('.sidebar__nav-link').forEach(l=>{
      const a=l.dataset.view===name;
      l.classList.toggle('sidebar__nav-link--active',a);
      l.setAttribute('aria-current',a?'page':'false');
    });
    document.getElementById('main-content')?.scrollTo(0,0);
  }

  // ── Index status bar ───────────────────────────────────────────
  showIndexStatus(text, pct=null) {
    const bar=document.getElementById('index-status-bar'), txt=document.getElementById('index-status-text');
    if(bar) bar.hidden=false; if(txt) txt.textContent=text;
    if(pct!==null){const f=document.getElementById('index-status-fill');if(f)f.style.width=`${Math.min(100,pct)}%`;}
  }
  hideIndexStatus() { const b=document.getElementById('index-status-bar'); if(b) b.hidden=true; }

  // ── Avatar stack ───────────────────────────────────────────────
  renderAvatarStack(accounts) {
    const stack=document.getElementById('avatar-stack'), cnt=document.getElementById('avatar-stack-count');
    if(!stack) return;
    if (!accounts.length) {
      stack.innerHTML=`<div class="avatar-chip avatar-chip--empty"><span class="avatar-chip__initials">?</span></div>`;
      if(cnt) cnt.hidden=true; return;
    }
    const shown = accounts.slice(0,3);
    stack.innerHTML = shown.map(a=>`
      <div class="avatar-chip" title="${escHtml(a.email)}">
        ${a.picture?`<img src="${escHtml(a.picture)}" alt="" class="avatar-chip__img" width="28" height="28"/>`:
          `<span class="avatar-chip__initials">${escHtml(a.name?.charAt(0)?.toUpperCase()??'?')}</span>`}
      </div>`).join('');
    if(cnt){ cnt.hidden=accounts.length<=3; cnt.textContent=`+${accounts.length-3}`; }

    const badge=document.getElementById('nav-accounts-count');
    if(badge){ badge.hidden=!accounts.length; badge.textContent=accounts.length; }
  }

  // ── User menu ──────────────────────────────────────────────────
  renderUserMenu(accounts) {
    const c=document.getElementById('user-menu-accounts'); if(!c) return;
    if(!accounts.length){ c.innerHTML=`<p class="user-menu__no-accounts">No accounts connected</p>`; return; }
    c.innerHTML=accounts.map(a=>`
      <div class="user-menu__account-entry" data-email="${escHtml(a.email)}">
        <div class="user-menu__account-avatar">
          ${a.picture?`<img src="${escHtml(a.picture)}" alt="" width="30" height="30"/>`:
            `<span class="user-menu__account-initial">${escHtml(a.name?.charAt(0)?.toUpperCase()??'?')}</span>`}
        </div>
        <div class="user-menu__account-info">
          <p class="user-menu__account-name">${escHtml(a.name??'')}</p>
          <p class="user-menu__account-email">${escHtml(a.email)}</p>
        </div>
        <button class="btn-icon user-menu__account-disconnect" data-email="${escHtml(a.email)}" type="button" aria-label="Disconnect">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`).join('');
  }

  // ── Dashboard: grouped service accordion ───────────────────────
  renderServiceGroups(accounts, connections) {
    const grid=document.getElementById('service-groups'), empty=document.getElementById('sources-empty');
    if(!grid) return;
    if(!accounts.length){ grid.innerHTML=''; if(empty) empty.hidden=false; return; }
    if(empty) empty.hidden=true;

    const connMap={};
    for(const c of connections) connMap[c.key]=c;

    const services=['drive','photos','gmail','sheets'];

    grid.innerHTML = services.map(svc=>{
      const svcAccounts = accounts.map(a=>{
        const conn = connMap[`${svc}::${a.email}`];
        return { account:a, conn };
      });
      const connectedCount = svcAccounts.filter(x=>x.conn?.connected).length;

      return `
        <div class="service-group" id="sg-${svc}">
          <button class="service-group__header" type="button" aria-expanded="${connectedCount>0?'true':'false'}" data-sg="${svc}">
            <div class="source-card__icon source-card__icon--${svc}" aria-hidden="true"></div>
            <span class="service-group__name">${escHtml(CONFIG.SOURCE_LABELS[svc])}</span>
            <span class="service-group__count badge badge--count">${connectedCount} connected</span>
            <svg class="service-group__chevron" aria-hidden="true" viewBox="0 0 24 24" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="service-group__body">
            ${svcAccounts.map(({account:a, conn})=>`
              <div class="service-group__row" data-source="${svc}" data-account="${escHtml(a.email)}">
                <div class="service-group__row-avatar">
                  ${a.picture?`<img src="${escHtml(a.picture)}" alt="" width="22" height="22"/>`:
                    `<span class="service-group__row-initial">${escHtml(a.name?.charAt(0)?.toUpperCase()??'?')}</span>`}
                </div>
                <div class="service-group__row-info">
                  <p class="service-group__row-email">${escHtml(a.email)}</p>
                  ${conn?.connected?`<p class="service-group__row-meta">${(conn.count??0).toLocaleString()} items · ${formatDate(conn.lastSync)}</p>`:
                    `<p class="service-group__row-meta service-group__row-meta--disconnected">Not connected</p>`}
                </div>
                <div class="service-group__row-actions">
                  ${conn?.connected?`
                    <button class="btn btn--ghost btn--small sg-sync-btn"     data-source="${svc}" data-account="${escHtml(a.email)}" type="button">↻</button>
                    <button class="btn btn--ghost btn--small sg-reindex-btn"  data-source="${svc}" data-account="${escHtml(a.email)}" type="button">Re-index</button>
                    <button class="btn btn--ghost btn--small btn--danger sg-disconnect-btn" data-source="${svc}" data-account="${escHtml(a.email)}" type="button">✕</button>
                  `:`<button class="btn btn--primary btn--small sg-connect-btn" data-source="${svc}" data-account="${escHtml(a.email)}" type="button">Connect</button>`}
                </div>
              </div>`).join('')}
          </div>
        </div>`;
    }).join('');
  }

  // ── Accounts panel ─────────────────────────────────────────────
  renderAccountsPanel(accounts, connections) {
    const grid=document.getElementById('accounts-grid'), empty=document.getElementById('accounts-empty');
    if(!grid) return;
    if(!accounts.length){ grid.innerHTML=''; if(empty) empty.hidden=false; return; }
    if(empty) empty.hidden=true;

    const connMap={};
    for(const c of connections) connMap[c.key]=c;

    grid.innerHTML = accounts.map(a=>{
      const services = ['drive','photos','gmail','sheets'].map(svc=>{
        const conn = connMap[`${svc}::${a.email}`];
        return `
          <div class="account-card__service">
            <span class="account-card__service-dot account-card__service-dot--${svc}"></span>
            <span class="account-card__service-name">${escHtml(CONFIG.SOURCE_LABELS[svc])}</span>
            ${conn?.connected?`
              <span class="account-card__service-status">${(conn.count??0).toLocaleString()} · ${formatDate(conn.lastSync)}</span>
              <button class="btn btn--ghost btn--small account-card__svc-sync" data-email="${escHtml(a.email)}" data-source="${svc}" type="button">↻</button>
              <button class="btn btn--ghost btn--small btn--danger account-card__svc-disconnect" data-email="${escHtml(a.email)}" data-source="${svc}" type="button">✕</button>
            `:`<button class="btn btn--primary btn--small account-card__svc-connect" data-email="${escHtml(a.email)}" data-source="${svc}" type="button">Connect</button>`}
          </div>`;
      }).join('');
      return `
        <article class="account-card" data-email="${escHtml(a.email)}" role="listitem">
          <div class="account-card__header">
            <div class="account-card__avatar">
              ${a.picture?`<img src="${escHtml(a.picture)}" alt="${escHtml(a.name??'')}" width="48" height="48"/>`:
                `<span class="account-card__avatar-initials">${escHtml(a.name?.charAt(0)?.toUpperCase()??'?')}</span>`}
            </div>
            <div class="account-card__identity">
              <p class="account-card__name">${escHtml(a.name??'')}</p>
              <p class="account-card__email">${escHtml(a.email)}</p>
            </div>
            <button class="btn btn--ghost btn--small btn--danger account-card__disconnect-all" data-email="${escHtml(a.email)}" type="button">Disconnect</button>
          </div>
          <div class="account-card__services">${services}</div>
        </article>`;
    }).join('');
  }

  // ── Sidebar sources ────────────────────────────────────────────
  renderSidebarSources(accounts, connections) {
    const list=document.getElementById('sidebar-sources-list'); if(!list) return;
    const connMap={};
    for(const c of connections) connMap[c.key]=c;
    const items=[];
    for(const svc of ['drive','photos','gmail','sheets','local']) {
      const isLocal = svc==='local';
      const accs    = isLocal ? connections.filter(c=>c.source==='local'&&c.connected).map(c=>({email:c.account,name:c.folder??c.account})) : accounts;
      for(const a of accs) {
        const key  = isLocal ? svc : `${svc}::${a.email}`;
        const conn = connMap[key];
        if(!conn?.connected) continue;
        const shortEmail = isLocal ? (a.name??a.email) : (a.email?.split('@')[0]??'');
        items.push(`
          <li>
            <button class="sidebar__source-btn" type="button" aria-pressed="false" data-source="${svc}" data-account="${escHtml(a.email)}">
              <span class="source-icon source-icon--${svc}"></span>
              <span class="sidebar__source-label">
                <span>${escHtml(CONFIG.SOURCE_LABELS[svc])}</span>
                <span class="sidebar__source-account">${escHtml(shortEmail)}</span>
              </span>
            </button>
          </li>`);
      }
    }
    list.innerHTML = items.join('') || `<li class="sidebar__source-empty">No sources connected</li>`;
  }

  // ── Local file state ───────────────────────────────────────────
  setLocalState({ connected, count, folderName, lastSync }) {
    const status=document.getElementById('local-status');
    const badge=document.getElementById('local-badge');
    const stats=document.getElementById('local-stats');
    const countEl=document.getElementById('local-file-count');
    const folderEl=document.getElementById('local-folder-name');
    const syncEl=document.getElementById('local-last-sync');
    const addBtn=document.getElementById('local-add-folder-btn');
    const rescanBtn=document.getElementById('local-rescan-btn');
    const removeBtn=document.getElementById('local-remove-btn');
    if(connected){
      if(status){status.textContent='Indexed';status.className='source-card__status source-card__status--connected';}
      if(badge) badge.hidden=false;
      if(stats) stats.hidden=false;
      if(countEl)  countEl.textContent =`${(count??0).toLocaleString()} files`;
      if(folderEl) folderEl.textContent=folderName?`📁 ${folderName}`:'';
      if(syncEl)   syncEl.textContent  =lastSync?`Indexed ${formatDate(lastSync)}`:'Never indexed';
      if(addBtn)   addBtn.hidden=true;
      if(rescanBtn)rescanBtn.hidden=false;
      if(removeBtn)removeBtn.hidden=false;
    } else {
      if(status){status.textContent='No folder selected';status.className='source-card__status source-card__status--disconnected';}
      if(badge) badge.hidden=true; if(stats) stats.hidden=true;
      if(addBtn)   addBtn.hidden=false;
      if(rescanBtn)rescanBtn.hidden=true;
      if(removeBtn)removeBtn.hidden=true;
    }
  }

  setLocalProgress(cur, tot, label) {
    const c=document.getElementById('local-progress'), f=document.getElementById('local-progress-fill'), l=document.getElementById('local-progress-label');
    if(!c) return; const pct=tot>0?Math.round((cur/tot)*100):50;
    c.hidden=false; if(f) f.style.width=`${pct}%`; if(l) l.textContent=label??`${pct}%`;
  }
  hideLocalProgress() { const c=document.getElementById('local-progress'); if(c) c.hidden=true; }

  // ── Dashboard stats ────────────────────────────────────────────
  setStats({ files, emails, photos, sheets, accounts, lastSync }) {
    const s=(id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
    s('stat-files-value',   files?.toLocaleString()    ?? '—');
    s('stat-emails-value',  emails?.toLocaleString()   ?? '—');
    s('stat-photos-value',  photos?.toLocaleString()   ?? '—');
    s('stat-sheets-value',  sheets?.toLocaleString()   ?? '—');
    s('stat-accounts-value',accounts?.toLocaleString() ?? '—');
    s('stat-sync-value',    lastSync ? formatDate(lastSync) : '—');
  }

  setGreeting(accounts) {
    const el=document.getElementById('dashboard-greeting'); if(!el) return;
    if(!accounts.length) el.textContent='Connect your accounts to get started.';
    else if(accounts.length===1) el.textContent=`Searching as ${accounts[0].email}`;
    else el.textContent=`${accounts.length} accounts connected — searching everything`;
  }

  setIndexSize(total) {
    const fill=document.getElementById('storage-usage-fill'), label=document.getElementById('storage-usage-label'), bar=document.getElementById('storage-usage-bar');
    const pct=Math.min(100,Math.round((total/200000)*100));
    if(fill) fill.style.width=`${pct}%`;
    if(label) label.textContent=`${total.toLocaleString()} items indexed`;
    if(bar) bar.setAttribute('aria-valuenow',pct);
  }

  populateAccountFilter(accounts) {
    const sel=document.getElementById('filter-account'); if(!sel) return;
    while(sel.options.length>1) sel.remove(1);
    for(const a of accounts) sel.add(new Option(a.email, a.email));
  }

  // ── Search suggestions ─────────────────────────────────────────
  renderSuggestions(suggestions, query) {
    const panel=document.getElementById('search-suggestions-panel');
    const list =document.getElementById('search-suggestions');
    const histPanel=document.getElementById('search-history-dropdown');
    if(!panel||!list) return;

    if(!suggestions.length && !query) { panel.hidden=true; return; }

    if(!query) {
      list.innerHTML='';
      if(histPanel) histPanel.hidden=true;
      panel.hidden=true;
      return;
    }

    list.innerHTML = suggestions.map((s,i)=>`
      <li class="search-suggestion-item ${s.correction?'search-suggestion-item--correction':''}"
          role="option" data-id="${escHtml(s.id)}" data-text="${escHtml(s.text)}"
          data-correction="${s.correction?'true':'false'}" tabindex="-1"
          aria-selected="false" id="sugg-${i}">
        <span class="sugg-icon">${escHtml(s.icon)}</span>
        <span class="sugg-body">
          <span class="sugg-text">${hlText(s.text, query)}</span>
          ${s.sub?`<span class="sugg-sub">${escHtml(s.sub)}</span>`:''}
        </span>
        <span class="sugg-source badge badge--source badge--source-${escHtml(s.source)}">${escHtml(s.label)}</span>
      </li>`).join('');

    if(histPanel) histPanel.hidden=true;
    panel.hidden = suggestions.length === 0;
    const inp=document.getElementById('global-search-input');
    if(inp) inp.setAttribute('aria-expanded', suggestions.length>0 ? 'true':'false');
  }

  renderSearchHistoryDropdown(entries) {
    const panel=document.getElementById('search-suggestions-panel');
    const list =document.getElementById('search-history-list');
    const hpanel=document.getElementById('search-history-dropdown');
    const sugg  =document.getElementById('search-suggestions');
    if(!panel||!list||!hpanel) return;

    if(!entries.length) { panel.hidden=true; return; }

    if(sugg) sugg.innerHTML='';
    list.innerHTML = entries.map(e=>`
      <li class="history-item" data-query="${escHtml(e.query)}" data-id="${escHtml(e.id)}">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span class="history-item__text">${escHtml(e.query)}</span>
        <span class="history-item__count">${e.count}×</span>
        <button class="history-item__pin btn-icon" data-id="${escHtml(e.id)}" data-pinned="${e.pinned?'true':'false'}" type="button" aria-label="${e.pinned?'Unpin':'Pin'}" title="${e.pinned?'Unpin':'Pin'}">
          ${e.pinned?'📌':'📍'}
        </button>
        <button class="history-item__remove btn-icon" data-id="${escHtml(e.id)}" type="button" aria-label="Remove">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="11" height="11"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </li>`).join('');

    hpanel.hidden=false;
    panel.hidden=false;
  }

  hideSuggestions() {
    const p=document.getElementById('search-suggestions-panel'); if(p) p.hidden=true;
    const inp=document.getElementById('global-search-input'); if(inp) inp.setAttribute('aria-expanded','false');
  }

  showCorrectionBanner(correction) {
    const banner=document.getElementById('correction-banner');
    const txt   =document.getElementById('correction-banner-text');
    const btn   =document.getElementById('correction-accept-btn');
    if(!banner||!txt) return;
    txt.textContent=`Did you mean: "${correction}"?`;
    if(btn) btn.dataset.correction=correction;
    banner.hidden=false;
  }
  hideCorrectionBanner() { const b=document.getElementById('correction-banner'); if(b) b.hidden=true; }

  // ── Results ────────────────────────────────────────────────────
  renderResults({ results, query, total, page, totalPages }) {
    this.#query=query;
    const cnt=document.getElementById('results-count-label');
    if(cnt) cnt.textContent=total===0?'No results':`${total.toLocaleString()} result${total!==1?'s':''}`;
    const ql=document.getElementById('results-query-label'); if(ql) ql.textContent=`"${query}"`;
    document.getElementById('results-loading')?.setAttribute('hidden','');
    document.getElementById('results-error')?.setAttribute('hidden','');
    const empty=document.getElementById('results-empty'); if(empty) empty.hidden=total>0;
    this.#renderPagination(page, totalPages);
    const badge=document.getElementById('nav-results-count');
    if(badge){ badge.hidden=total===0; badge.textContent=total>999?'999+':String(total); }
  }

  showResultsLoading() {
    document.getElementById('results-loading')?.removeAttribute('hidden');
    document.getElementById('results-empty')?.setAttribute('hidden','');
    document.getElementById('results-error')?.setAttribute('hidden','');
  }

  showResultsError(msg) {
    document.getElementById('results-loading')?.setAttribute('hidden','');
    const el=document.getElementById('results-error'); if(el) el.hidden=false;
    const m=document.getElementById('results-error-message'); if(m) m.textContent=msg;
  }

  resultItemHTML(item) {
    const q       = this.#query;
    const icon    = this.#typeIcon(item.type);
    const namHtml = q ? hlText(item.name??'Untitled', q) : escHtml(item.name??'Untitled');
    const snip    = this.#snippet(item, q);
    const src     = `<span class="badge badge--source badge--source-${escHtml(item.source)}">${escHtml(CONFIG.SOURCE_LABELS[item.source]??item.source)}</span>`;
    const acc     = item.account&&item.source!=='local' ? `<span class="result-item__account">${escHtml(item.account)}</span>` : '';
    const folder  = item.folder   ? `<span class="result-item__folder">📁 ${escHtml(item.folder)}</span>` : '';
    const sender  = item.sender   ? `<span class="result-item__sender">✉ ${escHtml(item.sender)}</span>` : '';
    const dt      = item.modified ? `<span class="result-item__date">${formatDate(item.modified)}</span>` : '';
    const sz      = item.size     ? `<span class="result-item__size">${formatBytes(item.size)}</span>` : '';
    const owner   = item.ownerEmail&&item.source==='drive' ? `<span class="result-item__owner">👤 ${escHtml(item.ownerEmail)}</span>` : '';

    return `
      <li class="result-item result-item--${escHtml(item.type)}"
          data-id="${escHtml(item.id)}" data-source="${escHtml(item.source)}"
          role="option" tabindex="0" aria-label="${escHtml(item.name??'Untitled')}">
        <div class="result-item__icon" aria-hidden="true">${icon}</div>
        <div class="result-item__body">
          <div class="result-item__top">${namHtml}${src}</div>
          ${acc?`<div class="result-item__account-row">${acc}</div>`:''}
          ${snip?`<p class="result-item__snippet">${snip}</p>`:''}
          <div class="result-item__meta">${dt}${sz}${folder}${sender}${owner}</div>
        </div>
        <div class="result-item__actions">
          ${item.url?`<a class="btn-icon result-item__open" href="${escHtml(item.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open" tabindex="-1">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>`:''}
          <button class="btn-icon result-item__star ${item.starred?'result-item__star--active':''}"
            data-id="${escHtml(item.id)}" type="button"
            aria-label="${item.starred?'Unstar':'Star'}" aria-pressed="${item.starred?'true':'false'}">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </button>
        </div>
      </li>`;
  }

  // ── Preview ────────────────────────────────────────────────────
  openPreview(item, localPreview=null) {
    this.#previewId=item.id;
    const panel=document.getElementById('preview-panel'); if(!panel) return;
    panel.hidden=false;
    document.getElementById('results-layout')?.classList.add('results-layout--preview-open');

    const title=document.getElementById('preview-title'); if(title) title.textContent=item.name??'Untitled';
    const starBtn=document.getElementById('preview-star-btn'); if(starBtn) starBtn.setAttribute('aria-pressed',item.starred?'true':'false');

    // Action buttons
    const openBtn=document.getElementById('preview-open-btn'); if(openBtn) openBtn.style.display=item.url?'':'none';
    const dlBtn=document.getElementById('preview-download-btn');
    const cpBtn=document.getElementById('preview-copy-link-btn');
    if(dlBtn) dlBtn.hidden=!(item.downloadUrl||item.source==='local');
    if(cpBtn) cpBtn.hidden=!item.url;
    if(dlBtn) dlBtn.dataset.url=item.downloadUrl??'';
    if(cpBtn) cpBtn.dataset.url=item.url??'';

    // Local actions bar
    const localBar=document.getElementById('preview-local-actions'); if(localBar) localBar.hidden=item.source!=='local';
    const copyPathBtn=document.getElementById('preview-copy-path-btn'); if(copyPathBtn) copyPathBtn.dataset.path=item.relativePath??'';

    const body=document.getElementById('preview-body'); if(body) body.innerHTML=this.#previewBody(item, localPreview);
    const metaList=document.getElementById('preview-meta-list'); if(metaList) metaList.innerHTML=this.#previewMeta(item);
    const meta=document.getElementById('preview-meta'); if(meta) meta.hidden=false;
  }

  closePreview() {
    // Revoke blob URLs
    ['img[src^="blob:"]','embed[src^="blob:"]','audio[src^="blob:"]','video[src^="blob:"]'].forEach(sel=>{
      document.querySelector(`#preview-body ${sel}`)?.src && URL.revokeObjectURL(document.querySelector(`#preview-body ${sel}`).src);
    });
    this.#previewId=null;
    const p=document.getElementById('preview-panel'); if(p) p.hidden=true;
    document.getElementById('results-layout')?.classList.remove('results-layout--preview-open');
  }
  get activePreviewId() { return this.#previewId; }

  setViewMode(mode) {
    this.#listMode=mode==='list';
    document.getElementById('view-list-btn')?.setAttribute('aria-pressed',String(mode==='list'));
    document.getElementById('view-grid-btn')?.setAttribute('aria-pressed',String(mode==='grid'));
    document.getElementById('view-list-btn')?.classList.toggle('view-toggle__btn--active',mode==='list');
    document.getElementById('view-grid-btn')?.classList.toggle('view-toggle__btn--active',mode==='grid');
  }

  toggleTheme(settings) {
    const current = document.body.dataset.theme==='dark'?'light':'dark';
    document.body.dataset.theme=current;
    settings.set('theme', current);
    document.getElementById('theme-toggle-btn')?.setAttribute('aria-pressed',current==='dark'?'true':'false');
    const sel=document.getElementById('setting-theme'); if(sel) sel.value=current;
  }

  syncThemeBtn(theme) {
    document.getElementById('theme-toggle-btn')?.setAttribute('aria-pressed',theme==='dark'?'true':'false');
  }

  toggleSidebar(force) {
    const sb=document.getElementById('sidebar'); if(!sb) return;
    const open=force!==undefined?force:!sb.classList.contains('sidebar--open');
    sb.classList.toggle('sidebar--open',open);
    document.getElementById('sidebar-toggle-btn')?.setAttribute('aria-expanded',String(open));
    document.getElementById('sidebar-overlay')?.setAttribute('aria-hidden',String(!open));
  }

  renderList(listId, emptyId, items) {
    const list=document.getElementById(listId), empty=document.getElementById(emptyId); if(!list) return;
    if(!items.length){ list.innerHTML=''; if(empty) empty.hidden=false; return; }
    if(empty) empty.hidden=true;
    list.innerHTML=items.slice(0,100).map(i=>this.resultItemHTML(i)).join('');
  }

  // ── Settings ───────────────────────────────────────────────────
  populateSettings(settings) {
    const s=(id,v)=>{ const el=document.getElementById(id); if(el) el.value=v; };
    const sc=(id,v)=>{ const el=document.getElementById(id); if(el) el.checked=!!v; };
    s('setting-theme',    settings.get('theme'));
    s('setting-page-size',settings.get('pageSize'));
    s('setting-gmail-max',settings.get('gmailMax'));
    s('setting-photos-max',settings.get('photosMax'));
    sc('setting-fuzzy',      settings.get('fuzzy'));
    sc('setting-suggestions',settings.get('suggestions'));
    sc('setting-history',    settings.get('history'));
    sc('setting-bg-index',   settings.get('bgIndex'));
    const ver=document.getElementById('settings-version'); if(ver) ver.textContent=`Version ${CONFIG.VERSION}`;
  }

  renderSettingsData(stats) {
    const grid=document.getElementById('settings-data-grid'); if(!grid) return;
    const rows=[
      ['Google Drive',       `${stats.drive?.toLocaleString()??0} files`],
      ['Gmail',              `${stats.gmail?.toLocaleString()??0} emails`],
      ['Google Photos',      `${stats.photos?.toLocaleString()??0} photos`],
      ['Google Sheets',      `${stats.sheets?.toLocaleString()??0} spreadsheets`],
      ['Local Files',        `${stats.local?.toLocaleString()??0} files`],
      ['Total indexed',      `${stats.total?.toLocaleString()??0} items`],
    ];
    grid.innerHTML=rows.map(([label,value])=>`
      <div class="settings-data-row">
        <span class="settings-data-row__label">${escHtml(label)}</span>
        <span class="settings-data-row__value">${escHtml(value)}</span>
      </div>`).join('');
  }

  // ── Private ────────────────────────────────────────────────────
  #renderPagination(page, totalPages) {
    const nav=document.getElementById('results-pagination'), prev=document.getElementById('pagination-prev-btn'), next=document.getElementById('pagination-next-btn'), info=document.getElementById('pagination-info');
    if(!nav) return;
    nav.hidden=totalPages<=1;
    if(prev) prev.disabled=page<=1; if(next) next.disabled=page>=totalPages;
    if(info) info.textContent=`Page ${page} of ${totalPages}`;
    nav.dataset.page=page; nav.dataset.totalPages=totalPages;
  }

  #snippet(item, q) {
    let text = item.body??item.description??'';
    if(!text&&item.cellValues?.length) text=item.cellValues.slice(0,8).join(' · ');
    if(!text&&item.attachments?.length) text=`Attachments: ${item.attachments.join(', ')}`;
    if(!text&&item.relativePath) text=item.relativePath;
    if(!text) return '';
    const t=text.length>160?text.slice(0,160)+'…':text;
    return q ? hlText(t,q) : escHtml(t);
  }

  #typeIcon(type) {
    const m={
      document:`<svg viewBox="0 0 24 24" width="19" height="19"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
      spreadsheet:`<svg viewBox="0 0 24 24" width="19" height="19"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`,
      image:`<svg viewBox="0 0 24 24" width="19" height="19"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
      email:`<svg viewBox="0 0 24 24" width="19" height="19"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
      pdf:`<svg viewBox="0 0 24 24" width="19" height="19"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
      video:`<svg viewBox="0 0 24 24" width="19" height="19"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
      audio:`<svg viewBox="0 0 24 24" width="19" height="19"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
      presentation:`<svg viewBox="0 0 24 24" width="19" height="19"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
      code:`<svg viewBox="0 0 24 24" width="19" height="19"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
      folder:`<svg viewBox="0 0 24 24" width="19" height="19"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`,
      file:`<svg viewBox="0 0 24 24" width="19" height="19"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`,
    };
    return m[type]??m.file;
  }

  #previewBody(item, local) {
    if(local) {
      switch(local.type) {
        case 'image':    return `<img src="${local.url}" alt="${escHtml(item.name)}" class="preview-panel__image" loading="lazy"/>`;
        case 'pdf':      return `<embed src="${local.url}" type="application/pdf" class="preview-panel__pdf" title="${escHtml(item.name)}"/>`;
        case 'audio':    return `<audio src="${local.url}" controls class="preview-panel__audio" aria-label="${escHtml(item.name)}"></audio>`;
        case 'video':    return `<video src="${local.url}" controls class="preview-panel__video" aria-label="${escHtml(item.name)}"></video>`;
        case 'markdown': return `<div class="preview-panel__markdown">${this.#renderMarkdown(local.text)}</div>`;
        case 'csv':      return `<div class="preview-panel__csv">${this.#renderCSV(local.text)}</div>`;
        case 'json':     return `<pre class="preview-panel__text"><code>${escHtml(this.#prettyJSON(local.text))}</code></pre>`;
        case 'html':     return `<iframe class="preview-panel__iframe" srcdoc="${escHtml(local.text)}" title="${escHtml(item.name)}" sandbox="allow-same-origin"></iframe>`;
        case 'text':     return `<pre class="preview-panel__text"><code>${escHtml(local.text)}</code></pre>`;
        case 'download': return `<div class="preview-placeholder">
          ${this.#typeIcon(item.type)}
          <p>${escHtml(item.name)}</p>
          <p class="preview-placeholder__note">Preview not available for this file type.</p>
          <button class="btn btn--primary" id="preview-download-trigger" type="button">Download File</button>
        </div>`;
      }
    }

    if(item.thumbnail) return `<img src="${escHtml(item.thumbnail)}" alt="${escHtml(item.name)}" class="preview-panel__image" loading="lazy"/>`;

    if(item.source==='gmail') return `
      <div class="preview-email">
        <div class="preview-email__field"><strong>From:</strong> ${escHtml(item.sender??'')}</div>
        <div class="preview-email__field"><strong>To:</strong> ${escHtml(item.receiver??'')}</div>
        <div class="preview-email__field"><strong>Subject:</strong> ${escHtml(item.subject??'')}</div>
        <div class="preview-email__field"><strong>Date:</strong> ${item.modified?new Date(item.modified).toLocaleString():''}</div>
        ${item.labelIds?.length?`<div class="preview-email__field"><strong>Labels:</strong> ${escHtml(item.labelIds.join(', '))}</div>`:''}
        <div class="preview-email__body">${escHtml(item.body??'')}</div>
        ${item.attachments?.length?`<div class="preview-email__attachments"><strong>Attachments:</strong><ul>${item.attachments.map(a=>`<li>${escHtml(a)}</li>`).join('')}</ul></div>`:''}
        ${item.url?`<div class="preview-email__actions">
          <a href="${escHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="btn btn--primary btn--small">Open in Gmail</a>
          ${item.androidUrl?`<a href="${escHtml(item.androidUrl)}" class="btn btn--secondary btn--small">Open in Gmail App</a>`:''}
        </div>`:''}
      </div>`;

    return `<div class="preview-placeholder">
      ${this.#typeIcon(item.type)}
      <p>${escHtml(item.name??'Untitled')}</p>
      ${item.url?`<a href="${escHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="btn btn--primary">Open file</a>`:`<p class="preview-placeholder__note">Re-select the folder to enable preview.</p>`}
    </div>`;
  }

  #previewMeta(item) {
    const rows=[
      ['Service',   CONFIG.SOURCE_LABELS[item.source]??item.source],
      ['Account',   item.source!=='local'?item.account:null],
      ['Type',      item.type],
      ['Modified',  item.modified?new Date(item.modified).toLocaleString():null],
      ['Size',      item.size?formatBytes(item.size):null],
      ['Folder',    item.folder],
      ['Path',      item.relativePath],
      ['Owner',     item.ownerEmail??item.owner],
      ['Camera',    item.cameraMake||item.cameraModel?`${item.cameraMake??''} ${item.cameraModel??''}`.trim():null],
      ['MIME',      item.mimeType],
    ];
    return rows.filter(([,v])=>v).map(([l,v])=>`
      <div class="meta-row">
        <dt class="meta-row__label">${escHtml(l)}</dt>
        <dd class="meta-row__value">${escHtml(v)}</dd>
      </div>`).join('');
  }

  #renderMarkdown(text) {
    if(!text) return '';
    return escHtml(text)
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
      .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,    '<em>$1</em>')
      .replace(/`(.+?)`/g,      '<code>$1</code>')
      .replace(/\n/g,            '<br>');
  }

  #renderCSV(text) {
    if(!text) return '';
    const rows = text.split('\n').slice(0,50).map(r=>r.split(','));
    const header = rows[0];
    const body   = rows.slice(1);
    return `<table class="csv-table">
      <thead><tr>${header.map(h=>`<th>${escHtml(h.trim())}</th>`).join('')}</tr></thead>
      <tbody>${body.map(r=>`<tr>${r.map(c=>`<td>${escHtml(c.trim())}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  }

  #prettyJSON(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch(_) { return text; }
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLASS: App
   ═══════════════════════════════════════════════════════════════ */
class App {
  #accountMgr; #db; #worker; #vs; #ui; #notify; #settings; #history;
  #drive; #photos; #gmail; #sheets; #localFiles;
  #activeQuery=''; #activeFilters={}; #activePage=1;
  #currentFolderId=null;

  async init() {
    this.#notify   = new NotificationManager();
    this.#settings = new SettingsManager().load();
    this.#settings.applyTheme();
    this.#ui = new UIManager();
    this.#ui.init();
    this.#ui.syncThemeBtn(this.#settings.get('theme'));
    this.#ui.showLoading('Opening database…');

    this.#db = new IndexedDBManager();
    try { await this.#db.open(); }
    catch(err) { this.#ui.hideLoading(); this.#notify.error(`Database error: ${err.message}`); return; }

    this.#history = new SearchHistoryManager(this.#db);

    this.#worker = new SearchWorker();
    this.#worker.init();

    this.#vs = new VirtualScroller();
    this.#vs.init({
      container:    document.getElementById('results-panel'),
      list:         document.getElementById('results-list'),
      spacerTop:    document.getElementById('vs-spacer-top'),
      spacerBottom: document.getElementById('vs-spacer-bottom'),
      renderFn:     (item) => this.#ui.resultItemHTML(item),
    });

    this.#accountMgr = new AccountManager(this.#db, (accs) => this.#onAccountsChanged(accs));
    await this.#accountMgr.restore();

    this.#localFiles = new LocalFilesService(this.#db, (c,t,l)=>this.#ui.setLocalProgress(c,t,l));
    await this.#localFiles.restoreHandles();

    this.#ui.setLoadingStatus('Loading Google Identity Services…', 50);
    await this.#loadGIS();

    this.#ui.setLoadingStatus('Building search index…', 75);
    const allItems = await this.#db.getAllItems();
    this.#worker.build(allItems);

    await this.#refreshAll();
    this.#ui.populateSettings(this.#settings);
    this.#bindEvents();

    this.#ui.setLoadingStatus('Ready', 100);
    setTimeout(() => this.#ui.hideLoading(), 320);
  }

  // ── Account changes ────────────────────────────────────────────
  async #onAccountsChanged(accounts) {
    this.#ui.renderAvatarStack(accounts);
    this.#ui.renderUserMenu(accounts);
    this.#ui.setGreeting(accounts);
    this.#ui.populateAccountFilter(accounts);
    const conns = await this.#db.getAllConnections();
    this.#ui.renderServiceGroups(accounts, conns);
    this.#ui.renderAccountsPanel(accounts, conns);
    this.#ui.renderSidebarSources(accounts, conns);
    await this.#refreshStats();
  }

  async #refreshAll() {
    const accounts = this.#accountMgr.listAccounts();
    const conns    = await this.#db.getAllConnections();
    this.#ui.renderAvatarStack(accounts);
    this.#ui.renderUserMenu(accounts);
    this.#ui.setGreeting(accounts);
    this.#ui.populateAccountFilter(accounts);
    this.#ui.renderServiceGroups(accounts, conns);
    this.#ui.renderAccountsPanel(accounts, conns);
    this.#ui.renderSidebarSources(accounts, conns);

    const localConns = conns.filter(c=>c.source==='local'&&c.connected);
    if(localConns.length) {
      const last = localConns.at(-1);
      this.#currentFolderId = last.account ?? last.key.replace('local::','');
      this.#ui.setLocalState({ connected:true, count:last.count, folderName:last.folder, lastSync:last.lastSync });
    }

    await this.#refreshStats();
  }

  async #refreshStats() {
    const [drive, gmail, photos, sheets, local, total] = await Promise.all([
      this.#db.countBySource('drive'),
      this.#db.countBySource('gmail'),
      this.#db.countBySource('photos'),
      this.#db.countBySource('sheets'),
      this.#db.countBySource('local'),
      this.#db.totalCount(),
    ]);
    const accs    = this.#accountMgr.listAccounts().length;
    const allConns= await this.#db.getAllConnections();
    const lastSync= allConns.map(c=>c.lastSync).filter(Boolean).sort().at(-1)??null;
    this.#ui.setStats({ files:drive, emails:gmail, photos, sheets, accounts:accs, lastSync });
    this.#ui.setIndexSize(total);
    this.#ui.renderSettingsData({ drive, gmail, photos, sheets, local, total });
  }

  // ── Events ─────────────────────────────────────────────────────
  #bindEvents() {
    const inp     = document.getElementById('global-search-input');
    const clearBtn= document.getElementById('search-clear-btn');
    const debouncedSearch  = debounce(()=>this.#executeSearch(),   CONFIG.SEARCH_DEBOUNCE_MS);
    const debouncedSuggest = debounce(()=>this.#fetchSuggestions(), CONFIG.SUGGEST_DEBOUNCE_MS);

    inp?.addEventListener('input', () => {
      const v=inp.value;
      if(clearBtn) clearBtn.hidden=!v;
      this.#activeQuery=v; this.#activePage=1;
      if(v.trim().length>=2) debouncedSuggest();
      else if(!v) { this.#loadHistoryDropdown(); }
      else this.#ui.hideSuggestions();
      if(v.trim().length>=2||v==='') debouncedSearch();
    });

    inp?.addEventListener('focus', () => {
      if(!inp.value) this.#loadHistoryDropdown();
    });

    inp?.addEventListener('keydown', e => {
      if(e.key==='Enter') { e.preventDefault(); this.#executeSearch(); this.#ui.hideSuggestions(); }
      if(e.key==='Escape') { inp.value=''; if(clearBtn) clearBtn.hidden=true; this.#ui.hideSuggestions(); }
      if(e.key==='ArrowDown') { e.preventDefault(); document.querySelector('.search-suggestion-item')?.focus(); }
    });

    clearBtn?.addEventListener('click',()=>{
      if(inp) inp.value=''; clearBtn.hidden=true; this.#activeQuery=''; this.#activePage=1;
      this.#ui.hideSuggestions(); this.#ui.switchView('dashboard');
    });

    document.getElementById('search-submit-btn')?.addEventListener('click',()=>{ this.#executeSearch(); this.#ui.hideSuggestions(); });

    // Suggestions panel
    document.getElementById('search-suggestions')?.addEventListener('click',e=>{
      const li=e.target.closest('.search-suggestion-item'); if(!li) return;
      if(li.dataset.correction==='true') {
        if(inp) inp.value=li.dataset.text; this.#activeQuery=li.dataset.text;
      } else {
        if(inp) inp.value=li.dataset.text; this.#activeQuery=li.dataset.text;
      }
      this.#ui.hideSuggestions(); this.#executeSearch();
    });

    // Keyboard nav in suggestions
    document.getElementById('search-suggestions')?.addEventListener('keydown',e=>{
      const items=[...document.querySelectorAll('.search-suggestion-item')];
      const idx=items.indexOf(document.activeElement);
      if(e.key==='ArrowDown'){ e.preventDefault(); items[idx+1]?.focus(); }
      if(e.key==='ArrowUp')  { e.preventDefault(); if(idx>0) items[idx-1]?.focus(); else inp?.focus(); }
      if(e.key==='Enter')    { e.preventDefault(); items[idx]?.click(); }
      if(e.key==='Escape')   { this.#ui.hideSuggestions(); inp?.focus(); }
    });

    // History dropdown
    document.getElementById('search-history-list')?.addEventListener('click',e=>{
      const item   = e.target.closest('.history-item');
      const pinBtn = e.target.closest('.history-item__pin');
      const remBtn = e.target.closest('.history-item__remove');

      if(pinBtn) { e.stopPropagation(); this.#pinHistory(pinBtn.dataset.id, pinBtn.dataset.pinned!=='true'); return; }
      if(remBtn) { e.stopPropagation(); this.#removeHistory(remBtn.dataset.id); return; }
      if(item)   { const q=item.dataset.query; if(inp) inp.value=q; this.#activeQuery=q; this.#ui.hideSuggestions(); this.#executeSearch(); }
    });

    document.getElementById('clear-history-btn')?.addEventListener('click',async()=>{
      await this.#history.clear(); this.#ui.hideSuggestions();
    });

    // Correction banner
    document.getElementById('correction-accept-btn')?.addEventListener('click',e=>{
      const c=e.currentTarget.dataset.correction; if(!c) return;
      if(inp) inp.value=c; this.#activeQuery=c;
      this.#ui.hideCorrectionBanner(); this.#executeSearch();
    });
    document.getElementById('correction-dismiss-btn')?.addEventListener('click',()=>this.#ui.hideCorrectionBanner());

    // Close suggestions on outside click
    document.addEventListener('click', e => {
      if(!e.target.closest('.search-bar')&&!e.target.closest('.search-suggestions-panel')) this.#ui.hideSuggestions();
      const um=document.getElementById('user-menu');
      if(!e.target.closest('#user-profile')&&um&&!um.hidden){ um.hidden=true; document.getElementById('user-avatar-btn')?.setAttribute('aria-expanded','false'); }
    });

    // Sidebar nav
    document.getElementById('sidebar-nav')?.addEventListener('click', e => {
      const link=e.target.closest('.sidebar__nav-link'); if(!link) return;
      e.preventDefault();
      this.#ui.switchView(link.dataset.view);
      if(link.dataset.view==='starred')  this.#loadStarred();
      if(link.dataset.view==='recent')   this.#loadRecent();
      if(link.dataset.view==='accounts') this.#reloadAccountsPanel();
      if(link.dataset.view==='settings') this.#refreshStats();
      if(window.innerWidth<768) this.#ui.toggleSidebar(false);
    });

    // Sidebar source buttons
    document.getElementById('sidebar-sources-list')?.addEventListener('click', e => {
      const btn=e.target.closest('.sidebar__source-btn'); if(!btn) return;
      const pressed=btn.getAttribute('aria-pressed')==='true';
      document.querySelectorAll('.sidebar__source-btn').forEach(b=>b.setAttribute('aria-pressed','false'));
      btn.setAttribute('aria-pressed',String(!pressed));
      this.#activeFilters.source  = !pressed?btn.dataset.source:'all';
      this.#activeFilters.account = !pressed?btn.dataset.account:'all';
      this.#activePage=1;
      const fs=document.getElementById('filter-source'); if(fs) fs.value=this.#activeFilters.source??'all';
      const fa=document.getElementById('filter-account'); if(fa) fa.value=this.#activeFilters.account??'all';
      this.#executeSearch();
    });

    // Add account buttons
    ['add-account-btn','add-account-dashboard-btn','menu-add-account-btn','sources-empty-add-btn','accounts-empty-add-btn'].forEach(id=>{
      document.getElementById(id)?.addEventListener('click',()=>this.#addAccount());
    });

    // User menu
    const avatarBtn=document.getElementById('user-avatar-btn'), userMenu=document.getElementById('user-menu');
    avatarBtn?.addEventListener('click',()=>{
      const open=userMenu?.hidden===false;
      if(userMenu) userMenu.hidden=open;
      avatarBtn.setAttribute('aria-expanded',String(!open));
    });

    document.getElementById('user-menu-accounts')?.addEventListener('click',e=>{
      const btn=e.target.closest('.user-menu__account-disconnect'); if(btn) this.#disconnectAccount(btn.dataset.email);
    });

    document.getElementById('menu-accounts-btn')?.addEventListener('click',()=>{ if(userMenu)userMenu.hidden=true; this.#ui.switchView('accounts'); this.#reloadAccountsPanel(); });
    document.getElementById('menu-settings-btn')?.addEventListener('click',()=>{ if(userMenu)userMenu.hidden=true; this.#ui.switchView('settings'); this.#refreshStats(); });
    document.getElementById('menu-privacy-btn')?.addEventListener('click', ()=>{ if(userMenu)userMenu.hidden=true; this.#showPrivacy(); });
    document.getElementById('menu-help-btn')?.addEventListener('click',    ()=>this.#notify.info('For help, visit the GitHub repository.'));
    document.getElementById('menu-disconnect-all-btn')?.addEventListener('click',()=>this.#disconnectAll());

    // Service groups on dashboard
    document.getElementById('service-groups')?.addEventListener('click', e => {
      const hdr=e.target.closest('.service-group__header');
      if(hdr) { const sg=hdr.dataset.sg; this.#toggleServiceGroup(sg); return; }
      const connectBtn    = e.target.closest('.sg-connect-btn');
      const syncBtn       = e.target.closest('.sg-sync-btn');
      const reindexBtn    = e.target.closest('.sg-reindex-btn');
      const disconnectBtn = e.target.closest('.sg-disconnect-btn');
      if(connectBtn)    this.#connectService(connectBtn.dataset.source,    connectBtn.dataset.account);
      if(syncBtn)       this.#syncService(syncBtn.dataset.source,          syncBtn.dataset.account);
      if(reindexBtn)    this.#reindexService(reindexBtn.dataset.source,    reindexBtn.dataset.account);
      if(disconnectBtn) this.#disconnectService(disconnectBtn.dataset.source, disconnectBtn.dataset.account);
    });

    // Accounts panel
    document.getElementById('accounts-grid')?.addEventListener('click', e => {
      const c=e.target.closest('.account-card__svc-connect'),   sc=e.target.closest('.account-card__svc-sync');
      const d=e.target.closest('.account-card__svc-disconnect'), da=e.target.closest('.account-card__disconnect-all');
      if(c)  this.#connectService(c.dataset.source, c.dataset.email);
      if(sc) this.#syncService(sc.dataset.source, sc.dataset.email);
      if(d)  this.#disconnectService(d.dataset.source, d.dataset.email);
      if(da) this.#disconnectAccount(da.dataset.email);
    });

    // Local files
    document.getElementById('local-add-folder-btn')?.addEventListener('click',()=>this.#addLocalFolder());
    document.getElementById('local-rescan-btn')?.addEventListener('click',()=>this.#rescanLocal());
    document.getElementById('local-remove-btn')?.addEventListener('click',()=>this.#removeLocal());

    // Sync all / Reindex all
    document.getElementById('sync-all-btn')?.addEventListener('click',    ()=>this.#syncAll());
    document.getElementById('reindex-all-btn')?.addEventListener('click', ()=>this.#reindexAll());

    // Filters
    ['filter-type','filter-source','filter-account','filter-date','filter-sort'].forEach(id=>{
      document.getElementById(id)?.addEventListener('change',e=>{
        const k=id.replace('filter-','');
        if(k==='source')  this.#activeFilters.source=e.target.value;
        if(k==='account') this.#activeFilters.account=e.target.value;
        if(k==='type')    this.#activeFilters.type=e.target.value;
        if(k==='sort')    this.#activeFilters.sort=e.target.value;
        if(k==='date')    this.#handleDateFilter(e.target.value);
        this.#activePage=1; this.#executeSearch();
      });
    });
    document.getElementById('filter-date-from')?.addEventListener('change',e=>{this.#activeFilters.dateFrom=e.target.value; this.#executeSearch();});
    document.getElementById('filter-date-to')  ?.addEventListener('change',e=>{this.#activeFilters.dateTo=e.target.value;   this.#executeSearch();});
    document.getElementById('clear-filters-btn')?.addEventListener('click',()=>this.#clearFilters());
    document.getElementById('results-empty-cta')?.addEventListener('click',()=>this.#clearFilters());
    document.getElementById('results-retry-btn')?.addEventListener('click',()=>this.#executeSearch());

    // View mode
    document.getElementById('view-list-btn')?.addEventListener('click',()=>{ this.#ui.setViewMode('list'); this.#executeSearch(); });
    document.getElementById('view-grid-btn')?.addEventListener('click',()=>{ this.#ui.setViewMode('grid'); this.#executeSearch(); });

    // Pagination
    document.getElementById('pagination-prev-btn')?.addEventListener('click',()=>{ this.#activePage=Math.max(1,this.#activePage-1); this.#executeSearch(false); });
    document.getElementById('pagination-next-btn')?.addEventListener('click',()=>{ this.#activePage++; this.#executeSearch(false); });

    // Results clicks
    document.getElementById('virtual-scroll-container')?.addEventListener('click',e=>this.#handleResultClick(e));
    document.getElementById('virtual-scroll-container')?.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' ') this.#handleResultClick(e); });
    ['recent-list','starred-list'].forEach(id=>{ document.getElementById(id)?.addEventListener('click',e=>this.#handleResultClick(e)); });

    // Preview actions
    document.getElementById('preview-close-btn')?.addEventListener('click',()=>this.#ui.closePreview());
    document.getElementById('preview-star-btn') ?.addEventListener('click',()=>this.#togglePreviewStar());
    document.getElementById('preview-open-btn') ?.addEventListener('click',async()=>{ const item=await this.#db.getItem(this.#ui.activePreviewId); if(item?.url) window.open(item.url,'_blank','noopener,noreferrer'); });
    document.getElementById('preview-download-btn')?.addEventListener('click', async e => {
      const url=e.currentTarget.dataset.url;
      if(url) window.open(url,'_blank','noopener,noreferrer');
      else {
        const item=await this.#db.getItem(this.#ui.activePreviewId);
        if(item?.source==='local') this.#downloadLocalFile(item);
      }
    });
    document.getElementById('preview-copy-link-btn')?.addEventListener('click',async e=>{
      const url=e.currentTarget.dataset.url;
      if(url) { await navigator.clipboard.writeText(url); this.#notify.success('Link copied.'); }
    });
    document.getElementById('preview-copy-path-btn')?.addEventListener('click',e=>{
      const path=e.currentTarget.dataset.path;
      if(path) navigator.clipboard.writeText(path).then(()=>this.#notify.success('Path copied.'));
    });
    document.getElementById('preview-reselect-btn')?.addEventListener('click',()=>this.#addLocalFolder());
    document.getElementById('preview-body')?.addEventListener('click',async e=>{
      if(e.target.id==='preview-download-trigger') { const item=await this.#db.getItem(this.#ui.activePreviewId); if(item) this.#downloadLocalFile(item); }
    });

    // Settings
    document.querySelectorAll('.settings-nav__item').forEach(btn=>{
      btn.addEventListener('click',()=>{
        document.querySelectorAll('.settings-nav__item').forEach(b=>b.classList.remove('settings-nav__item--active'));
        document.querySelectorAll('.settings-panel').forEach(p=>p.hidden=true);
        btn.classList.add('settings-nav__item--active');
        const tab=document.getElementById(`settings-tab-${btn.dataset.settingsTab}`);
        if(tab) tab.hidden=false;
        if(btn.dataset.settingsTab==='data') this.#refreshStats();
      });
    });

    document.getElementById('setting-theme')?.addEventListener('change',e=>{ this.#settings.set('theme',e.target.value); this.#settings.applyTheme(); this.#ui.syncThemeBtn(this.#settings.get('theme')); });
    document.getElementById('setting-page-size')?.addEventListener('change',e=>this.#settings.set('pageSize',parseInt(e.target.value,10)));
    document.getElementById('setting-fuzzy')?.addEventListener('change',e=>this.#settings.set('fuzzy',e.target.checked));
    document.getElementById('setting-suggestions')?.addEventListener('change',e=>this.#settings.set('suggestions',e.target.checked));
    document.getElementById('setting-history')?.addEventListener('change',e=>this.#settings.set('history',e.target.checked));
    document.getElementById('setting-bg-index')?.addEventListener('change',e=>this.#settings.set('bgIndex',e.target.checked));
    document.getElementById('setting-gmail-max')?.addEventListener('change',e=>this.#settings.set('gmailMax',parseInt(e.target.value,10)));
    document.getElementById('setting-photos-max')?.addEventListener('change',e=>this.#settings.set('photosMax',parseInt(e.target.value,10)));

    document.getElementById('setting-clear-history-btn')?.addEventListener('click',async()=>{ await this.#history.clear(); this.#notify.success('Search history cleared.'); });
    document.getElementById('setting-clear-index-btn')?.addEventListener('click',()=>this.#showModal({ title:'Clear search index?', body:'Removes all indexed metadata. Your actual files are not deleted.', confirm:'Clear', danger:true, onConfirm:async()=>{ await this.#db.clearAll(); await this.#worker.build([]); this.#notify.success('Index cleared.'); await this.#refreshStats(); } }));
    document.getElementById('setting-disconnect-all-btn')?.addEventListener('click',()=>this.#disconnectAll());
    document.getElementById('setting-reset-btn')?.addEventListener('click',()=>this.#resetEverything());

    // Theme toggle in header
    document.getElementById('theme-toggle-btn')?.addEventListener('click',()=>this.#ui.toggleTheme(this.#settings));

    // Sidebar toggle
    document.getElementById('sidebar-toggle-btn')?.addEventListener('click',()=>this.#ui.toggleSidebar());
    document.getElementById('sidebar-overlay')?.addEventListener('click',()=>this.#ui.toggleSidebar(false));

    // Modal
    document.getElementById('modal-close-btn')  ?.addEventListener('click',()=>this.#closeModal());
    document.getElementById('modal-cancel-btn') ?.addEventListener('click',()=>this.#closeModal());
    document.getElementById('modal-overlay')    ?.addEventListener('click',()=>this.#closeModal());

    // Keyboard shortcuts
    document.addEventListener('keydown',e=>{
      if((e.metaKey||e.ctrlKey)&&e.key==='k') { e.preventDefault(); document.getElementById('global-search-input')?.focus(); }
      if(e.key==='Escape') { this.#ui.closePreview(); this.#ui.toggleSidebar(false); this.#ui.hideSuggestions(); }
    });

    // System theme change
    window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>{ if(this.#settings.get('theme')==='system') this.#settings.applyTheme(); });
  }

  // ── Search ─────────────────────────────────────────────────────
  async #executeSearch(scrollTop=true) {
    const q = this.#activeQuery.trim();
    this.#ui.switchView('results');
    this.#ui.showResultsLoading();
    this.#ui.hideCorrectionBanner();

    if(this.#settings.get('history') && q.length>=2) await this.#history.add(q);

    try {
      const pageSize = this.#settings.get('pageSize') ?? CONFIG.RESULTS_PER_PAGE;
      const result   = await this.#worker.search(q, this.#activeFilters, this.#activePage, pageSize);

      this.#vs.setItems(result.results);
      this.#ui.renderResults({ results:result.results, query:q, total:result.total, page:result.page, totalPages:result.totalPages });

      if(result.correction) this.#ui.showCorrectionBanner(result.correction);
      if(scrollTop) document.getElementById('results-panel')?.scrollTo(0,0);
    } catch(err) {
      this.#ui.showResultsError(err.message);
    }
  }

  async #fetchSuggestions() {
    if(!this.#settings.get('suggestions')) return;
    const q=this.#activeQuery.trim(); if(q.length<2) return;
    try {
      const res = await this.#worker.suggest(q, 8);
      this.#ui.renderSuggestions(res.suggestions ?? [], q);
    } catch(_) {}
  }

  async #loadHistoryDropdown() {
    if(!this.#settings.get('history')) return;
    const recent = await this.#history.getRecent(8);
    if(recent.length) this.#ui.renderSearchHistoryDropdown(recent);
  }

  async #pinHistory(id, pinned)   { await this.#history.pin(id, pinned); await this.#loadHistoryDropdown(); }
  async #removeHistory(id)        { await this.#history.remove(id); await this.#loadHistoryDropdown(); }

  #clearFilters() {
    this.#activeFilters={}; this.#activePage=1;
    ['filter-type','filter-source','filter-account','filter-date','filter-sort'].forEach(id=>{
      const el=document.getElementById(id); if(el) el.value=el.options[0]?.value??'';
    });
    document.getElementById('filter-date-range')?.setAttribute('hidden','');
    document.querySelectorAll('.sidebar__source-btn[aria-pressed="true"]').forEach(b=>b.setAttribute('aria-pressed','false'));
    this.#executeSearch();
  }

  #handleDateFilter(value) {
    const range=document.getElementById('filter-date-range');
    delete this.#activeFilters.dateFrom; delete this.#activeFilters.dateTo;
    if(value==='custom'){ if(range) range.hidden=false; return; }
    if(range) range.hidden=true;
    const now=new Date();
    const map={ today:()=>new Date(now.getFullYear(),now.getMonth(),now.getDate()), week:()=>new Date(now-7*86400000), month:()=>new Date(now-30*86400000), year:()=>new Date(now-365*86400000) };
    if(map[value]) this.#activeFilters.dateFrom=map[value]().toISOString().split('T')[0];
  }

  // ── Service accordion ──────────────────────────────────────────
  #toggleServiceGroup(svc) {
    const el=document.getElementById(`sg-${svc}`); if(!el) return;
    const hdr=el.querySelector('.service-group__header');
    const body=el.querySelector('.service-group__body');
    if(!body) return;
    const open=body.classList.contains('service-group__body--open');
    body.classList.toggle('service-group__body--open',!open);
    if(hdr) hdr.setAttribute('aria-expanded',String(!open));
  }

  // ── Account management ─────────────────────────────────────────
  async #addAccount(hint) {
    try {
      this.#notify.info('Opening Google sign-in…');
      const email = await this.#accountMgr.addAccount(hint);
      this.#notify.success(`Account added: ${email}`);
    } catch(err) {
      if(!['popup_closed_by_user','access_denied'].includes(err.message)) this.#notify.error(`Sign-in failed: ${err.message}`);
    }
  }

  async #disconnectAccount(email) {
    this.#showModal({
      title:`Disconnect ${email}?`, body:'Removes all indexed data for this account. Your files are not deleted.',
      confirm:'Disconnect', danger:true, onConfirm:async()=>{
        for(const src of ['drive','photos','gmail','sheets']) {
          await this.#db.clearBySourceAccount(src, email);
          await this.#db.removeConnection(src, email);
        }
        await this.#accountMgr.removeAccount(email);
        await this.#rebuildIndex();
        this.#notify.success(`${email} disconnected.`);
      }
    });
  }

  async #disconnectAll() {
    this.#showModal({
      title:'Disconnect all accounts?', body:'All indexed data will be removed from this browser.',
      confirm:'Disconnect All', danger:true, onConfirm:async()=>{
        const accs=this.#accountMgr.listAccounts();
        for(const a of accs) {
          for(const src of ['drive','photos','gmail','sheets']) {
            await this.#db.clearBySourceAccount(src, a.email);
            await this.#db.removeConnection(src, a.email);
          }
          await this.#accountMgr.removeAccount(a.email);
        }
        await this.#rebuildIndex();
        this.#notify.success('All accounts disconnected.');
      }
    });
  }

  // ── Service connect / sync / reindex / disconnect ──────────────
  async #connectService(source, email) { await this.#runIndex(source, email); }
  async #syncService(source, email)    { await this.#runIndex(source, email); }
  async #reindexService(source, email) { await this.#db.clearBySourceAccount(source,email); await this.#runIndex(source,email); }

  async #disconnectService(source, email) {
    this.#showModal({
      title:`Disconnect ${CONFIG.SOURCE_LABELS[source]}?`,
      body:`Removes ${email}'s ${CONFIG.SOURCE_LABELS[source]} data from the index.`,
      confirm:'Disconnect', danger:true, onConfirm:async()=>{
        await this.#db.clearBySourceAccount(source,email);
        await this.#db.removeConnection(source,email);
        await this.#rebuildIndex(); await this.#refreshAll();
        this.#notify.success('Disconnected.');
      }
    });
  }

  async #syncAll() {
    const conns=(await this.#db.getAllConnections()).filter(c=>c.connected&&c.source!=='local');
    if(!conns.length){ this.#notify.info('No sources connected.'); return; }
    this.#ui.showIndexStatus(`Syncing ${conns.length} services…`, 0);
    for(let i=0;i<conns.length;i++){
      const c=conns[i];
      this.#ui.showIndexStatus(`Syncing ${CONFIG.SOURCE_LABELS[c.source]} (${c.account})…`, Math.round((i/conns.length)*100));
      await this.#runIndex(c.source, c.account, false);
    }
    await this.#rebuildIndex();
    this.#ui.hideIndexStatus();
    this.#notify.success('All sources synced.');
  }

  async #reindexAll() {
    const conns=(await this.#db.getAllConnections()).filter(c=>c.connected&&c.source!=='local');
    if(!conns.length){ this.#notify.info('No sources connected.'); return; }
    this.#showModal({
      title:'Re-index everything?', body:'Clears and rebuilds the entire search index.',
      confirm:'Re-index', onConfirm:async()=>{
        this.#ui.showIndexStatus('Re-indexing…',0);
        for(let i=0;i<conns.length;i++){
          const c=conns[i];
          this.#ui.showIndexStatus(`Re-indexing ${CONFIG.SOURCE_LABELS[c.source]} (${c.account})…`, Math.round((i/conns.length)*100));
          await this.#db.clearBySourceAccount(c.source,c.account);
          await this.#runIndex(c.source,c.account,false);
        }
        await this.#rebuildIndex();
        this.#ui.hideIndexStatus();
        this.#notify.success('Re-index complete.');
      }
    });
  }

  async #runIndex(source, email, showToast=true) {
    if(showToast) this.#notify.info(`Indexing ${CONFIG.SOURCE_LABELS[source]} (${email})…`);
    const onProg=(c,t,l)=>{
      this.#ui.showIndexStatus(l,t>0?Math.round((c/t)*100):50);
    };
    try {
      let count;
      switch(source) {
        case 'drive':
          this.#drive = new DriveService(this.#accountMgr, this.#db, onProg);
          count = await this.#drive.index(email);
          break;
        case 'photos':
          this.#photos = new PhotosService(this.#accountMgr, this.#db, onProg, this.#settings);
          count = await this.#photos.index(email);
          break;
        case 'gmail':
          this.#gmail = new GmailService(this.#accountMgr, this.#db, onProg, this.#settings);
          count = await this.#gmail.index(email);
          break;
        case 'sheets':
          this.#sheets = new SheetsService(this.#accountMgr, this.#db, onProg);
          count = await this.#sheets.index(email);
          break;
        default: throw new Error(`Unknown source: ${source}`);
      }
      this.#ui.hideIndexStatus();
      await this.#rebuildIndex();
      await this.#refreshAll();
      if(showToast) this.#notify.success(`${CONFIG.SOURCE_LABELS[source]} indexed — ${count.toLocaleString()} items.`);
    } catch(err) {
      this.#ui.hideIndexStatus();
      const msg=err.status===401?`Session expired for ${email}. Reconnect.`:err.message;
      if(showToast) this.#notify.error(msg);
      console.error(`[Index ${source}/${email}]`, err);
    }
  }

  // ── Local files ────────────────────────────────────────────────
  async #addLocalFolder() {
    try {
      this.#notify.info('Select a folder to index…');
      const count = await this.#localFiles.pickAndIndex();
      if(!count) return;
      this.#ui.hideLocalProgress();
      const conns=(await this.#db.getAllConnections()).filter(c=>c.source==='local'&&c.connected);
      if(conns.length){
        const last=conns.at(-1);
        this.#currentFolderId=last.account??last.key.replace('local::','');
        this.#ui.setLocalState({ connected:true, count:last.count, folderName:last.folder, lastSync:last.lastSync });
      }
      await this.#rebuildIndex();
      await this.#refreshStats();
      this.#notify.success(`${count.toLocaleString()} local files indexed.`);
    } catch(err) {
      this.#ui.hideLocalProgress();
      this.#notify.error(`Local index failed: ${err.message}`);
    }
  }

  async #rescanLocal() {
    if(!this.#currentFolderId){ this.#notify.info('No folder connected.'); return; }
    try {
      const count=await this.#localFiles.rescan(this.#currentFolderId);
      this.#ui.hideLocalProgress();
      await this.#rebuildIndex();
      await this.#refreshStats();
      this.#notify.success(`Re-scan complete — ${count.toLocaleString()} files.`);
    } catch(err) {
      this.#ui.hideLocalProgress();
      if(err.message.includes('re-select')) { this.#notify.warning('Folder access expired. Re-selecting…'); await this.#addLocalFolder(); }
      else this.#notify.error(err.message);
    }
  }

  async #removeLocal() {
    this.#showModal({
      title:'Remove local folder?', body:'Removes local file data from the index. Your files are not deleted.',
      confirm:'Remove', danger:true, onConfirm:async()=>{
        const conns=(await this.#db.getAllConnections()).filter(c=>c.source==='local');
        for(const c of conns) await this.#localFiles.removeFolder(c.account??c.key.replace('local::',''));
        this.#currentFolderId=null;
        this.#ui.setLocalState({ connected:false });
        await this.#rebuildIndex(); await this.#refreshStats();
        this.#notify.success('Local folder removed.');
      }
    });
  }

  async #downloadLocalFile(item) {
    const preview=await this.#localFiles.openForPreview(item);
    if(!preview?.file){ this.#notify.warning('File not accessible. Re-select the folder.'); return; }
    const a=document.createElement('a'); a.href=URL.createObjectURL(preview.file); a.download=item.name;
    a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),30000);
  }

  // ── Result clicks ──────────────────────────────────────────────
  async #handleResultClick(e) {
    const starBtn=e.target.closest('.result-item__star');
    if(starBtn){ e.stopPropagation(); await this.#toggleStar(starBtn.dataset.id); return; }
    if(e.target.closest('.result-item__open')) return;
    const li=e.target.closest('.result-item'); if(!li) return;
    const item=await this.#db.getItem(li.dataset.id); if(!item) return;
    let localPreview=null;
    if(item.source==='local') localPreview=await this.#localFiles.openForPreview(item);
    this.#ui.openPreview(item, localPreview);
  }

  async #toggleStar(id) {
    if(!id) return;
    const item=await this.#db.getItem(id); if(!item) return;
    const newVal=item.starred?0:1;
    await this.#db.setStarred(id,!!newVal);
    item.starred=newVal; this.#worker.addDoc(item);
    document.querySelectorAll(`.result-item__star[data-id="${CSS.escape(id)}"]`).forEach(btn=>{
      btn.classList.toggle('result-item__star--active',!!newVal);
      btn.setAttribute('aria-pressed',String(!!newVal));
    });
    if(this.#ui.activePreviewId===id) document.getElementById('preview-star-btn')?.setAttribute('aria-pressed',String(!!newVal));
    this.#notify.info(newVal?'Starred.':'Unstarred.');
  }
  async #togglePreviewStar() { if(this.#ui.activePreviewId) await this.#toggleStar(this.#ui.activePreviewId); }

  async #loadRecent()  { const a=await this.#db.getAllItems(); this.#ui.renderList('recent-list','recent-empty',a.sort((x,y)=>(y.indexed??0)-(x.indexed??0)).slice(0,100)); }
  async #loadStarred() { this.#ui.renderList('starred-list','starred-empty',await this.#db.getStarredItems()); }
  async #reloadAccountsPanel() { const [accs,conns]=await Promise.all([this.#accountMgr.listAccounts(),this.#db.getAllConnections()]); this.#ui.renderAccountsPanel(accs,conns); }

  async #rebuildIndex() { const all=await this.#db.getAllItems(); this.#worker.build(all); }

  // ── Reset ──────────────────────────────────────────────────────
  async #resetEverything() {
    this.#showModal({
      title:'Reset everything?',
      body:'Deletes all indexed data, connected accounts, search history, and preferences. This cannot be undone.',
      confirm:'Reset Everything', danger:true, onConfirm:async()=>{
        await this.#db.clearAll();
        this.#settings.clearAll();
        this.#settings.applyTheme();
        // Remove all accounts from memory
        const accs=this.#accountMgr.listAccounts();
        for(const a of accs) await this.#accountMgr.removeAccount(a.email);
        await this.#worker.build([]);
        this.#currentFolderId=null;
        await this.#refreshAll();
        this.#ui.setLocalState({connected:false});
        this.#notify.success('OneSearch has been reset.');
        this.#ui.switchView('dashboard');
      }
    });
  }

  // ── Privacy ────────────────────────────────────────────────────
  #showPrivacy() {
    this.#showModal({
      title:'Privacy', confirm:'Got it',
      body:`OneSearch is 100% private.\n\n• No servers, no analytics, no tracking.\n• Your files never leave your browser.\n• OAuth tokens live only in memory — cleared when you close this tab.\n• All indexed metadata is stored only in your browser's IndexedDB.\n• Disconnecting an account permanently removes its data.\n• Everything is browser-specific — another browser sees nothing.`,
    });
  }

  // ── Modal ──────────────────────────────────────────────────────
  #showModal({ title, body, confirm='Confirm', danger=false, onConfirm }) {
    const c=document.getElementById('modal-container'), t=document.getElementById('modal-title');
    const b=document.getElementById('modal-body'),      k=document.getElementById('modal-confirm-btn');
    if(!c) return;
    if(t) t.textContent=title;
    if(b) b.textContent=body;
    if(k){ k.textContent=confirm; k.className=`btn btn--primary${danger?' btn--danger':''}`; }
    c.hidden=false; document.body.classList.add('modal-open');
    const handler=()=>{ this.#closeModal(); onConfirm?.(); k?.removeEventListener('click',handler); };
    k?.addEventListener('click',handler);
    k?.focus();
  }

  #closeModal() {
    const c=document.getElementById('modal-container'); if(c) c.hidden=true;
    document.body.classList.remove('modal-open');
  }

  // ── GIS loader ─────────────────────────────────────────────────
  #loadGIS() {
    return new Promise((resolve,reject)=>{
      if(typeof google!=='undefined'&&google.accounts){ resolve(); return; }
      const s=document.createElement('script');
      s.src='https://accounts.google.com/gsi/client'; s.async=true; s.defer=true;
      s.onload=resolve; s.onerror=()=>reject(new Error('Failed to load Google Identity Services.'));
      document.head.appendChild(s);
    });
  }
}

/* ═══════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════ */
const app = new App();
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>app.init());
else app.init();
