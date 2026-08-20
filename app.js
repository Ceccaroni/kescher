/* ===========================================================================
   KESCHER — app logic
   - Tickets + Screenshots lokal in IndexedDB (nichts geht verloren)
   - "in Inbox schreiben" materialisiert sie als Markdown + Bilder in einen
     via File System Access API gewählten Ordner (persistent)
   =========================================================================== */
'use strict';

/* ---------- kleine Helfer ---------- */
const $ = (sel) => document.querySelector(sel);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

const TYPES = { idea: 'Idee', feature: 'Feature', bug: 'Bug', task: 'Task' };

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function relTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  return new Date(ms).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' });
}
function slug(str) {
  const map = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'ae', Ö: 'oe', Ü: 'ue' };
  return (str || '')
    .replace(/[äöüßÄÖÜ]/g, (c) => map[c] || c)
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'ticket';
}
function firstLine(str) { return (str || '').split('\n')[0].trim().slice(0, 80); }
function extFor(mime, name) {
  const m = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };
  if (m[mime]) return m[mime];
  const dot = (name || '').lastIndexOf('.');
  if (dot > -1) return name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  return 'png';
}
function yaml(str) { return '"' + String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function safeFilename(name, ext) {
  let base = (name || 'datei').replace(/[\/\\]/g, '-').replace(/[\x00-\x1f<>:"|?*]/g, '').trim() || 'datei';
  if (ext && !/\.[a-z0-9]+$/i.test(base)) base += '.' + ext;
  return base;
}
function suffixName(name, n) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

/* ---------- IndexedDB ---------- */
const DB_NAME = 'kescher';
let _db;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('tickets')) d.createObjectStore('tickets', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode) { return db().then((d) => d.transaction(store, mode).objectStore(store)); }
function idbGetAll() {
  return tx('tickets', 'readonly').then((s) => new Promise((res, rej) => {
    const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
  }));
}
function idbPut(t) {
  return tx('tickets', 'readwrite').then((s) => new Promise((res, rej) => {
    const r = s.put(t); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }));
}
function idbDel(id) {
  return tx('tickets', 'readwrite').then((s) => new Promise((res, rej) => {
    const r = s.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }));
}
function kvGet(k) {
  return tx('kv', 'readonly').then((s) => new Promise((res, rej) => {
    const r = s.get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
function kvSet(k, v) {
  return tx('kv', 'readwrite').then((s) => new Promise((res, rej) => {
    const r = s.put(v, k); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }));
}

/* ---------- State ---------- */
let tickets = [];
let draft = { type: 'idea', files: [] };
let editingId = null;
let rootHandle = null;
let connected = false;
let draftUrls = [];
let listUrls = [];
let selected = new Set();   // IDs ausgewählter offener Tickets
let lastSelId = null;       // Anker für Shift-Bereichsauswahl
let openOrder = [];         // Reihenfolge der offenen Tickets

/* ---------- Elemente ---------- */
const el = {
  title: $('#titleInput'), body: $('#bodyInput'), typeChips: $('#typeChips'),
  drop: $('#drop'), thumbs: $('#thumbs'), fileInput: $('#fileInput'),
  addBtn: $('#addBtn'), editHint: $('#editHint'), cancelEdit: $('#cancelEdit'),
  list: $('#list'), empty: $('#emptyState'), openCount: $('#openCount'),
  connectBtn: $('#connectBtn'), folderChip: $('#connectBtn'), folderLabel: $('#folderLabel'),
  flushBtn: $('#flushBtn'), flushCount: $('#flushCount'), flushLabel: $('#flushLabel'),
  doneWrap: $('#doneWrap'), doneToggle: $('#doneToggle'), doneList: $('#doneList'),
  doneCount: $('#doneCount'), clearDone: $('#clearDone'), toast: $('#toast'),
  selTools: $('#selTools'), selectAll: $('#selectAll'), selInfo: $('#selInfo'), selClear: $('#selClear'),
};

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, kind = '') {
  el.toast.innerHTML = msg;
  el.toast.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.className = 'toast'; }, 3200);
}

/* ---------- Anhänge im Composer (Bilder + beliebige Dateien) ---------- */
function addAttachment(file) {
  if (!file) return;
  const isImage = (file.type || '').startsWith('image/');
  draft.files.push({
    id: uuid(),
    name: file.name || (isImage ? 'pasted.png' : 'datei'),
    type: file.type || '',
    blob: file,
    isImage,
  });
  renderThumbs();
  flashDrop();
}
function flashDrop() {
  el.drop.classList.add('dragover');
  setTimeout(() => el.drop.classList.remove('dragover'), 180);
}
function renderThumbs() {
  draftUrls.forEach(URL.revokeObjectURL);
  draftUrls = [];
  el.thumbs.innerHTML = '';
  draft.files.forEach((f) => {
    let node;
    if (f.isImage) {
      const url = URL.createObjectURL(f.blob); draftUrls.push(url);
      node = document.createElement('div');
      node.className = 'thumb';
      node.innerHTML = `<img src="${url}" alt="" /><button class="rm" title="entfernen" type="button">✕</button>`;
    } else {
      node = document.createElement('div');
      node.className = 'attach';
      node.innerHTML = `<span class="attach-ext">${extFor(f.type, f.name).toUpperCase().slice(0, 4)}</span>` +
                       `<span class="attach-name"></span>` +
                       `<button class="rm" title="entfernen" type="button">✕</button>`;
      node.querySelector('.attach-name').textContent = f.name;
    }
    node.querySelector('.rm').addEventListener('click', (e) => {
      e.stopPropagation();
      draft.files = draft.files.filter((x) => x.id !== f.id);
      renderThumbs();
    });
    el.thumbs.appendChild(node);
  });
}

/* ---------- Composer speichern / zurücksetzen ---------- */
function resetComposer() {
  el.title.value = '';
  el.body.value = '';
  draft = { type: 'idea', files: [] };
  editingId = null;
  syncTypeChips();
  renderThumbs();
  el.addBtn.textContent = 'Erfassen';
  el.editHint.hidden = true;
}
function syncTypeChips() {
  el.typeChips.querySelectorAll('.chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.type === draft.type));
}
async function saveTicket() {
  const title = el.title.value.trim();
  const body = el.body.value.trim();
  let effTitle = title || firstLine(body) || (draft.files.length ? 'Anhang' : '');
  if (!effTitle) { el.title.focus(); toast('Titel, Text oder Anhang fehlt.'); return; }

  let t;
  if (editingId) {
    t = tickets.find((x) => x.id === editingId);
    if (!t) { resetComposer(); return; }
    t.title = effTitle; t.body = body; t.type = draft.type; t.files = draft.files;
  } else {
    t = { id: uuid(), title: effTitle, body, type: draft.type, files: draft.files,
          createdAt: Date.now(), exportedAt: null };
    tickets.push(t);
  }
  await idbPut(t);
  resetComposer();
  render();
  el.title.focus();
  toast(editingId ? 'Aktualisiert.' : '<span class="t-accent">✦</span> Im Kescher.');
}

function loadForEdit(id) {
  const t = tickets.find((x) => x.id === id);
  if (!t || t.exportedAt) return;
  editingId = id;
  el.title.value = t.title;
  el.body.value = t.body || '';
  draft = { type: t.type, files: (t.files || []).slice() };
  syncTypeChips();
  renderThumbs();
  el.addBtn.textContent = 'Aktualisieren';
  el.editHint.hidden = false;
  el.title.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteTicket(id, node) {
  const t = tickets.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`„${t.title}" löschen?`)) return;
  if (node) node.classList.add('leaving');
  setTimeout(async () => {
    tickets = tickets.filter((x) => x.id !== id);
    await idbDel(id);
    if (editingId === id) resetComposer();
    render();
  }, node ? 300 : 0);
}

/* ---------- Rendering ---------- */
function typeAccent(type) {
  return { idea: 'var(--idea)', feature: 'var(--feature)', bug: 'var(--bug)', task: 'var(--task)' }[type] || 'var(--amber)';
}
function ticketNode(t, done) {
  const node = document.createElement('article');
  node.className = 'ticket' + (done ? ' done' : '');
  node.dataset.id = t.id;
  node.style.setProperty('--accent-bar', typeAccent(t.type));

  const atts = t.files || [];
  const thumbs = atts.slice(0, 4).map((f) => {
    if (f.isImage) {
      const url = URL.createObjectURL(f.blob); listUrls.push(url);
      return `<img src="${url}" alt="" loading="lazy" />`;
    }
    return `<span class="filechip">${extFor(f.type, f.name).toUpperCase().slice(0, 4)}</span>`;
  }).join('');
  const extra = atts.length > 4 ? `<span class="more">+${atts.length - 4}</span>` : '';
  const checkbox = done ? '' :
    `<button class="tick" type="button" role="checkbox" aria-checked="false" aria-label="auswählen"></button>`;

  node.innerHTML = `
    ${checkbox}
    <div class="ticket-main">
      <div class="ticket-title"></div>
      <div class="ticket-meta">
        <span class="badge">${TYPES[t.type] || t.type}</span>
        <span>${done ? 'geschrieben' : relTime(t.createdAt)}</span>
        ${atts.length ? `<span>· ${atts.length} 📎</span>` : ''}
      </div>
      ${t.body ? `<div class="ticket-body"></div>` : ''}
      ${thumbs ? `<div class="ticket-thumbs">${thumbs}${extra}</div>` : ''}
    </div>`;
  node.querySelector('.ticket-title').textContent = t.title;
  if (t.body) node.querySelector('.ticket-body').textContent = t.body;

  if (!done) {
    const actions = document.createElement('div');
    actions.className = 'ticket-actions';
    actions.innerHTML =
      `<button class="icon-btn" title="bearbeiten" type="button">✎</button>
       <button class="icon-btn danger" title="löschen" type="button">🗑</button>`;
    const [editB, delB] = actions.querySelectorAll('button');
    editB.addEventListener('click', (e) => { e.stopPropagation(); loadForEdit(t.id); });
    delB.addEventListener('click', (e) => { e.stopPropagation(); deleteTicket(t.id, node); });
    node.appendChild(actions);

    const cb = node.querySelector('.tick');
    cb.addEventListener('click', (e) => { e.stopPropagation(); selectClick(t.id, e.shiftKey); });
    node.addEventListener('click', (e) => {
      if (e.target.closest('.icon-btn') || e.target.closest('.tick')) return;
      selectClick(t.id, e.shiftKey);
    });
    node.title = 'Klick = auswählen · Shift-Klick = Bereich · ✎ = bearbeiten';
    if (selected.has(t.id)) { node.classList.add('selected'); cb.setAttribute('aria-checked', 'true'); }
  }
  return node;
}

// Auswahl: einzeln togglen, mit Shift den Bereich seit dem letzten Klick
function selectClick(id, shift) {
  if (shift && lastSelId && openOrder.includes(lastSelId) && openOrder.includes(id)) {
    let a = openOrder.indexOf(lastSelId), b = openOrder.indexOf(id);
    if (a > b) { const tmp = a; a = b; b = tmp; }
    for (let i = a; i <= b; i++) selected.add(openOrder[i]);
  } else {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
  }
  lastSelId = id;
  syncSelectionUI();
  updateFlushUI();
}

function syncSelectionUI() {
  el.list.querySelectorAll('.ticket').forEach((n) => {
    const on = selected.has(n.dataset.id);
    n.classList.toggle('selected', on);
    const cb = n.querySelector('.tick');
    if (cb) cb.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

function selectAllToggle() {
  const allSel = openOrder.length > 0 && openOrder.every((id) => selected.has(id));
  if (allSel) selected.clear();
  else openOrder.forEach((id) => selected.add(id));
  lastSelId = null;
  syncSelectionUI();
  updateFlushUI();
}

function clearSelection() {
  selected.clear();
  lastSelId = null;
  syncSelectionUI();
  updateFlushUI();
}

function updateFlushUI() {
  const open = tickets.filter((t) => !t.exportedAt);
  for (const id of [...selected]) if (!open.some((t) => t.id === id)) selected.delete(id);
  const sel = selected.size;
  el.openCount.textContent = open.length;
  el.flushCount.textContent = sel || open.length;
  el.flushBtn.disabled = open.length === 0;
  el.flushLabel.textContent = sel ? 'Ausgewählte schreiben' : 'Alle schreiben';

  // Auswahl-Werkzeuge im Listenkopf
  el.selTools.style.display = open.length ? 'inline-flex' : 'none';
  const allSel = open.length > 0 && sel === open.length;
  el.selectAll.setAttribute('aria-checked', allSel ? 'true' : (sel ? 'mixed' : 'false'));
  el.selClear.hidden = sel === 0;
  el.selInfo.textContent = sel ? `${sel} ausgewählt` : 'alle';
}

function render() {
  listUrls.forEach(URL.revokeObjectURL);
  listUrls = [];

  const open = tickets.filter((t) => !t.exportedAt).sort((a, b) => b.createdAt - a.createdAt);
  const done = tickets.filter((t) => t.exportedAt).sort((a, b) => b.exportedAt - a.exportedAt);
  openOrder = open.map((t) => t.id);

  el.list.innerHTML = '';
  open.forEach((t) => el.list.appendChild(ticketNode(t, false)));
  el.empty.style.display = open.length ? 'none' : 'block';

  updateFlushUI();

  // Geschrieben-Bereich
  el.doneWrap.hidden = done.length === 0;
  el.doneCount.textContent = done.length;
  el.doneList.innerHTML = '';
  done.forEach((t) => el.doneList.appendChild(ticketNode(t, true)));
  el.clearDone.hidden = done.length === 0 || el.doneList.hidden;

  updateFolderUI();
}

/* ---------- File System Access ---------- */
const FS_OK = 'showDirectoryPicker' in window;

async function verifyPermission(handle, request) {
  const opts = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (request && (await handle.requestPermission(opts)) === 'granted') return true;
  } catch (_) {}
  return false;
}
function setConnected(name) {
  connected = true;
  el.folderChip.classList.add('connected');
  el.folderLabel.textContent = name;
}
function updateFolderUI() {
  if (!connected) {
    el.folderChip.classList.remove('connected');
    if (rootHandle) el.folderLabel.textContent = 'erneut freigeben';
    else el.folderLabel.textContent = FS_OK ? 'Ordner verbinden' : 'Browser nicht unterstützt';
  }
}
async function connectFolder() {
  if (!FS_OK) { toast('Dieser Browser hat keine File System Access API. Nimm Chrome, Arc, Brave oder Edge.', 'err'); return false; }
  // Bestehenden Ordner nur neu freigeben?
  if (rootHandle && !connected) {
    if (await verifyPermission(rootHandle, true)) { setConnected(rootHandle.name); render(); return true; }
  }
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'kescher-inbox' });
    if (await verifyPermission(dir, true)) {
      rootHandle = dir;
      await kvSet('rootHandle', dir);
      setConnected(dir.name);
      render();
      toast(`Verbunden: <span class="t-accent">${dir.name}/inbox</span>`, 'ok');
      return true;
    }
  } catch (e) { if (e && e.name !== 'AbortError') toast('Ordner konnte nicht verbunden werden.', 'err'); }
  return false;
}

async function writeFile(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}
function buildMarkdown(t, refs) {
  const created = new Date(t.createdAt).toISOString();
  let md = `---\ntitle: ${yaml(t.title)}\ntype: ${t.type}\ncreated: ${created}\nstatus: open\n---\n\n`;
  const body = (t.body || '').trim();
  if (body) md += body + '\n';
  if (refs.length) {
    md += `\n## Anhänge\n\n` +
      refs.map((r) => r.isImage ? `![${r.name}](${r.name})` : `[${r.name}](${r.name})`).join('\n') + '\n';
  }
  return md;
}
async function flush() {
  const open = tickets.filter((t) => !t.exportedAt).sort((a, b) => a.createdAt - b.createdAt);
  const chosen = selected.size ? open.filter((t) => selected.has(t.id)) : open;
  if (!chosen.length) return;
  if (!connected) { const ok = await connectFolder(); if (!ok) return; }
  if (!(await verifyPermission(rootHandle, true))) { connected = false; render(); toast('Zugriff auf den Ordner fehlt.', 'err'); return; }

  el.flushBtn.disabled = true;
  let written = 0;
  try {
    const inbox = await rootHandle.getDirectoryHandle('inbox', { create: true });
    for (const t of chosen) {
      const dir = await inbox.getDirectoryHandle(`${stamp(t.createdAt)}_${slug(t.title)}`, { create: true });
      const refs = [];
      const usedNames = new Set();
      let imgIdx = 1;
      for (const f of (t.files || [])) {
        const ext = extFor(f.type, f.name);
        const generic = !f.name || /^(image|pasted|screenshot|unbenannt|datei|grafik)/i.test(f.name);
        let base = (f.isImage && generic) ? `shot-${imgIdx}.${ext}` : safeFilename(f.name, ext);
        let fname = base, n = 2;
        while (usedNames.has(fname)) fname = suffixName(base, n++);
        usedNames.add(fname);
        await writeFile(dir, fname, f.blob);
        if (f.isImage) imgIdx++;
        refs.push({ name: fname, isImage: f.isImage });
      }
      await writeFile(dir, 'ticket.md', new Blob([buildMarkdown(t, refs)], { type: 'text/markdown' }));
      t.exportedAt = Date.now();
      selected.delete(t.id);
      await idbPut(t);
      written++;
    }
    render();
    toast(`<span class="t-accent">${written}</span> Ticket${written === 1 ? '' : 's'} → ${rootHandle.name}/inbox/`, 'ok');
  } catch (e) {
    console.error(e);
    render();
    toast('Schreiben fehlgeschlagen: ' + (e && e.message ? e.message : e), 'err');
  }
}

async function clearDoneTickets() {
  const done = tickets.filter((t) => t.exportedAt);
  if (!done.length) return;
  if (!confirm(`${done.length} bereits geschriebene aus der App entfernen? (Die Dateien im inbox/-Ordner bleiben.)`)) return;
  for (const t of done) await idbDel(t.id);
  tickets = tickets.filter((t) => !t.exportedAt);
  render();
  toast('Aufgeräumt.');
}

/* ---------- Events ---------- */
function wire() {
  el.typeChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    draft.type = chip.dataset.type; syncTypeChips();
  });

  el.addBtn.addEventListener('click', saveTicket);
  el.cancelEdit.addEventListener('click', () => resetComposer());

  // Cmd/Ctrl+Enter erfasst
  [el.title, el.body].forEach((n) => n.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveTicket(); }
  }));

  // Drop-Zone
  el.drop.addEventListener('click', (e) => { if (!e.target.closest('.thumb') && !e.target.closest('.attach')) el.fileInput.click(); });
  el.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); } });
  el.fileInput.addEventListener('change', () => { [...el.fileInput.files].forEach(addAttachment); el.fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add('dragover'); }));
  ['dragleave', 'dragend'].forEach((ev) => el.drop.addEventListener(ev, () => el.drop.classList.remove('dragover')));
  el.drop.addEventListener('drop', (e) => {
    e.preventDefault(); el.drop.classList.remove('dragover');
    [...(e.dataTransfer.files || [])].forEach(addAttachment);
  });

  // Einfügen per Cmd+V (Screenshot aus der Zwischenablage oder kopierte Datei)
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData ? e.clipboardData.items : [];
    let found = false;
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile(); if (f) { addAttachment(f); found = true; }
      }
    }
    if (found) e.preventDefault();
  });

  el.connectBtn.addEventListener('click', connectFolder);
  el.flushBtn.addEventListener('click', flush);
  el.selectAll.addEventListener('click', selectAllToggle);
  el.selClear.addEventListener('click', clearSelection);
  el.doneToggle.addEventListener('click', () => {
    const open = el.doneList.hidden;
    el.doneList.hidden = !open;
    el.doneToggle.classList.toggle('open', open);
    el.clearDone.hidden = !open || tickets.every((t) => !t.exportedAt);
  });
  el.clearDone.addEventListener('click', clearDoneTickets);
}

/* ---------- Init ---------- */
async function init() {
  wire();
  syncTypeChips();
  try {
    tickets = await idbGetAll();
    // Migration: altes Feld images -> files, isImage nachziehen
    tickets.forEach((t) => {
      if (!t.files) t.files = t.images || [];
      t.files.forEach((f) => { if (f.isImage === undefined) f.isImage = (f.type || '').startsWith('image/'); });
    });
    const saved = await kvGet('rootHandle');
    if (saved) {
      rootHandle = saved;
      if (await verifyPermission(saved, false)) setConnected(saved.name);
    }
  } catch (e) { console.error(e); }
  render();
  el.title.focus();

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (_) {}
  }
}
init();
