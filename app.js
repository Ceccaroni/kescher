/* ===========================================================================
   KESCHER — app logic
   - Tickets + Screenshots lokal in IndexedDB (nichts geht verloren)
   - "in Inbox schreiben" materialisiert sie als Markdown + Bilder in den
     Ticket-Ordner des gewählten Projekts (File System Access API, persistent)
   - Mehrere Projekte/Repos: jedes mit eigenem Ordner-Handle + Ticket-Unterordner
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
let draft = { type: 'idea', files: [], projectId: null };
let editingId = null;
let draftUrls = [];
let listUrls = [];
let selected = new Set();   // IDs ausgewählter offener Tickets
let lastSelId = null;       // Anker für Shift-Bereichsauswahl
let openOrder = [];         // Reihenfolge der offenen Tickets

// Projekte (Repos + Ticket-Ordner) — beliebig erweiterbar
let projects = [];            // [{ id, name, handle, subdir, color, granted(transient) }]
let activeProjectId = null;   // zuletzt gewähltes Ziel für neue Tickets
let projForm = { editingId: null, handle: null }; // Zustand des Anlegen/Bearbeiten-Formulars
const PROJECT_COLORS = ['#0fa79a', '#3f74e0', '#e0544b', '#2f9e57', '#9b59b6', '#e08a1e', '#d6455f'];

/* ---------- Elemente ---------- */
const el = {
  title: $('#titleInput'), body: $('#bodyInput'), typeChips: $('#typeChips'),
  drop: $('#drop'), thumbs: $('#thumbs'), fileInput: $('#fileInput'),
  addBtn: $('#addBtn'), editHint: $('#editHint'), cancelEdit: $('#cancelEdit'),
  list: $('#list'), empty: $('#emptyState'), openCount: $('#openCount'),
  flushBtn: $('#flushBtn'), flushCount: $('#flushCount'), flushLabel: $('#flushLabel'),
  doneWrap: $('#doneWrap'), doneToggle: $('#doneToggle'), doneList: $('#doneList'),
  doneCount: $('#doneCount'), clearDone: $('#clearDone'), toast: $('#toast'),
  selTools: $('#selTools'), selectAll: $('#selectAll'), selInfo: $('#selInfo'), selClear: $('#selClear'),
  projSelect: $('#projSelect'), projBtn: $('#projBtn'), projName: $('#projName'),
  projDot: $('#projDot'), projPop: $('#projPop'),
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
  draft = { type: 'idea', files: [], projectId: activeProjectId };
  editingId = null;
  syncTypeChips();
  syncProjectSelector();
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
    t.projectId = draft.projectId || activeProjectId;
  } else {
    t = { id: uuid(), title: effTitle, body, type: draft.type, files: draft.files,
          projectId: draft.projectId || activeProjectId,
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
  draft = { type: t.type, files: (t.files || []).slice(), projectId: t.projectId || activeProjectId };
  syncTypeChips();
  syncProjectSelector();
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

  const projP = getProject(t.projectId);
  const projTag = projP
    ? `<span class="proj-tag"><span class="proj-tag-dot" style="background:${projP.color || 'var(--accent)'}"></span><span class="proj-tag-name"></span></span>`
    : (t.projectId ? `<span class="proj-tag missing">Projekt&nbsp;fehlt</span>` : '');

  node.innerHTML = `
    ${checkbox}
    <div class="ticket-main">
      <div class="ticket-title"></div>
      <div class="ticket-meta">
        <span class="badge">${TYPES[t.type] || t.type}</span>
        ${projTag}
        <span>${done ? 'geschrieben' : relTime(t.createdAt)}</span>
        ${atts.length ? `<span>· ${atts.length} 📎</span>` : ''}
      </div>
      ${t.body ? `<div class="ticket-body"></div>` : ''}
      ${thumbs ? `<div class="ticket-thumbs">${thumbs}${extra}</div>` : ''}
    </div>`;
  node.querySelector('.ticket-title').textContent = t.title;
  if (projP) node.querySelector('.proj-tag-name').textContent = projP.name;
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
}

/* ---------- File System Access ---------- */
const FS_OK = 'showDirectoryPicker' in window;

async function verifyPermission(handle, request) {
  if (!handle) return false;
  const opts = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (request && (await handle.requestPermission(opts)) === 'granted') return true;
  } catch (_) {}
  return false;
}
async function pickDirectory() {
  if (!FS_OK) { toast('Dieser Browser hat keine File System Access API. Nimm Chrome, Arc, Brave oder Edge.', 'err'); return null; }
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'kescher-repo' });
    if (await verifyPermission(dir, true)) return dir;
    toast('Ordner ohne Schreibrecht.', 'err');
  } catch (e) { if (e && e.name !== 'AbortError') toast('Ordner konnte nicht gewählt werden.', 'err'); }
  return null;
}
async function ensureProjectPermission(p, request) {
  if (!p || !p.handle) return false;
  const ok = await verifyPermission(p.handle, request);
  p.granted = ok;
  return ok;
}
// Repo-Root → (verschachtelter) Ticket-Ordner, bei Bedarf angelegt
async function resolveTicketDir(p) {
  let dir = p.handle;
  const parts = String(p.subdir || 'inbox').split('/').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}

async function writeFile(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}
function buildMarkdown(t, refs, projectName) {
  const created = new Date(t.createdAt).toISOString();
  let md = `---\ntitle: ${yaml(t.title)}\ntype: ${t.type}\ncreated: ${created}\nstatus: open\n`;
  if (projectName) md += `project: ${yaml(projectName)}\n`;
  md += `---\n\n`;
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

  if (!projects.length) {
    toast('Kein Projekt angelegt — lege zuerst ein Zielprojekt an.', 'err');
    openProjectPop(); openProjectForm(null);
    return;
  }

  // Tickets nach Zielprojekt gruppieren
  const groups = new Map();  // projectId -> [tickets]
  const unassigned = [];
  for (const t of chosen) {
    let pid = getProject(t.projectId) ? t.projectId : (projects.length === 1 ? projects[0].id : null);
    if (!pid) { unassigned.push(t); continue; }
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(t);
  }
  if (unassigned.length) {
    toast(`${unassigned.length} Ticket${unassigned.length === 1 ? '' : 's'} ohne Projekt — bitte Zielprojekt zuweisen.`, 'err');
    return;
  }

  // Berechtigungen vorab anfragen (noch innerhalb der Klick-Aktivierung)
  for (const pid of groups.keys()) {
    const p = getProject(pid);
    const ok = await ensureProjectPermission(p, true);
    if (!ok) { toast(`Zugriff auf „${p.name}" bestätigen und erneut schreiben.`, 'err'); refreshProjectPop(); return; }
  }
  refreshProjectPop();

  el.flushBtn.disabled = true;
  const prevDone = tickets.filter((t) => t.exportedAt);  // frühere Schreibvorgänge
  let written = 0;
  const targets = new Set();
  try {
    for (const [pid, list] of groups) {
      const p = getProject(pid);
      const ticketRoot = await resolveTicketDir(p);
      for (const t of list) {
        const dir = await ticketRoot.getDirectoryHandle(`${stamp(t.createdAt)}_${slug(t.title)}`, { create: true });
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
        await writeFile(dir, 'ticket.md', new Blob([buildMarkdown(t, refs, p.name)], { type: 'text/markdown' }));
        t.exportedAt = Date.now();
        selected.delete(t.id);
        await idbPut(t);
        written++;
      }
      targets.add(`${p.name}/${p.subdir || 'inbox'}`);
    }
    // Archiv nur mit dem aktuellen Schreibvorgang füllen – ältere entfernen
    if (prevDone.length) {
      const prevIds = new Set(prevDone.map((p) => p.id));
      for (const p of prevDone) await idbDel(p.id);
      tickets = tickets.filter((x) => !prevIds.has(x.id));
    }
    render();
    toast(`<span class="t-accent">${written}</span> Ticket${written === 1 ? '' : 's'} → ${[...targets].join(', ')}`, 'ok');
  } catch (e) {
    console.error(e);
    render();
    toast('Schreiben fehlgeschlagen: ' + (e && e.message ? e.message : e), 'err');
  }
}

async function clearDoneTickets() {
  const done = tickets.filter((t) => t.exportedAt);
  if (!done.length) return;
  if (!confirm(`${done.length} bereits geschriebene aus der App entfernen? (Die Dateien im Ticket-Ordner bleiben.)`)) return;
  for (const t of done) await idbDel(t.id);
  tickets = tickets.filter((t) => !t.exportedAt);
  render();
  toast('Aufgeräumt.');
}

/* ---------- Projekte: Auswahl + Verwaltung ---------- */
function getProject(id) { return id ? projects.find((p) => p.id === id) || null : null; }
function activeProject() { return getProject(activeProjectId); }
function nextProjectColor() {
  const used = new Set(projects.map((p) => p.color));
  return PROJECT_COLORS.find((c) => !used.has(c)) || PROJECT_COLORS[projects.length % PROJECT_COLORS.length];
}
function persistProjects() {
  return kvSet('projects', projects.map((p) => ({ id: p.id, name: p.name, handle: p.handle, subdir: p.subdir, color: p.color })));
}

// Trigger-Button (Composer) an das aktuelle Ziel angleichen
function syncProjectSelector() {
  const p = getProject(draft.projectId) || activeProject();
  if (p) {
    el.projName.textContent = p.name;
    el.projDot.style.background = p.color || 'var(--accent)';
    el.projDot.style.visibility = 'visible';
    el.projSelect.classList.add('has-project');
    // Zustand in den zugänglichen Namen (enthält den sichtbaren Text → WCAG 2.5.3)
    el.projBtn.setAttribute('aria-label', `Zielprojekt: ${p.name}`);
  } else {
    el.projName.textContent = projects.length ? 'Projekt wählen' : 'Projekt anlegen';
    el.projDot.style.visibility = 'hidden';
    el.projSelect.classList.remove('has-project');
    el.projBtn.removeAttribute('aria-label');  // sichtbarer Text ist dann der Name
  }
}

function selectProject(id) {
  if (!getProject(id)) return;
  activeProjectId = id;
  draft.projectId = id;
  kvSet('activeProjectId', id);
  syncProjectSelector();
  closeProjectPop(true);  // Fokus zurück zum Trigger (Zeile wird aus dem DOM entfernt)
}
// Nach einem Rebuild den Fokus auf eine sinnvolle Stelle im offenen Popover setzen
function focusProjectRow(id) {
  const pop = el.projPop;
  if (pop.hidden) return;
  let btn = null;
  if (id) {
    const row = [...pop.querySelectorAll('.proj-row')].find((r) => r.dataset.pid === id);
    if (row) btn = row.querySelector('.proj-pick');
  }
  (btn || pop.querySelector('.proj-add') || el.projBtn).focus();
}

async function saveProjectForm() {
  const pop = el.projPop;
  const name = pop.querySelector('#projFormName').value.trim();
  const subdir = pop.querySelector('#projFormSub').value.trim() || 'inbox';
  if (!name) { pop.querySelector('#projFormName').focus(); toast('Projektname fehlt.', 'err'); return; }
  if (!projForm.handle) { toast('Bitte Repository-Ordner wählen.', 'err'); return; }

  let savedId;
  if (projForm.editingId) {
    const p = getProject(projForm.editingId);
    if (!p) { closeProjectForm(); return; }
    p.name = name; p.subdir = subdir; p.handle = projForm.handle; p.granted = true;
    savedId = p.id;
  } else {
    const p = { id: uuid(), name, subdir, handle: projForm.handle, color: nextProjectColor(), granted: true };
    projects.push(p);
    savedId = p.id;
    if (!activeProjectId) {
      activeProjectId = p.id; draft.projectId = p.id;
      await kvSet('activeProjectId', p.id);
    }
  }
  await persistProjects();
  closeProjectForm();
  buildProjectPop();
  syncProjectSelector();
  render();
  focusProjectRow(savedId);  // Fokus auf das gespeicherte Projekt statt ins Leere (M4)
  toast('Projekt gespeichert.', 'ok');
}

async function removeProject(id) {
  const p = getProject(id);
  if (!p) return;
  if (!confirm(`Projekt „${p.name}" entfernen?\nTickets bleiben erhalten, verlieren aber die Zuordnung.`)) return;
  projects = projects.filter((x) => x.id !== id);
  if (activeProjectId === id) {
    activeProjectId = projects[0] ? projects[0].id : null;
    await kvSet('activeProjectId', activeProjectId);
  }
  if (draft.projectId === id) draft.projectId = activeProjectId;
  await persistProjects();
  buildProjectPop();
  syncProjectSelector();
  render();
  focusProjectRow(activeProjectId);  // Fokus auf verbleibendes Projekt bzw. „hinzufügen" (B3)
}

/* ---------- Projekt-Popover (Bauen / Öffnen / Schließen) ---------- */
function buildProjectForm() {
  const form = document.createElement('div');
  form.className = 'proj-form';
  form.hidden = true;
  form.innerHTML = `
    <div class="proj-form-title" id="projFormTitle">Neues Projekt</div>
    <label class="proj-field">
      <span>Name</span>
      <input type="text" class="proj-input" id="projFormName" placeholder="z. B. SELAS" autocomplete="off" spellcheck="false" />
    </label>
    <div class="proj-field">
      <span>Repository-Ordner</span>
      <button type="button" class="proj-folder-btn" id="projFormFolder">Ordner wählen …</button>
    </div>
    <label class="proj-field">
      <span>Ticket-Ordner</span>
      <input type="text" class="proj-input" id="projFormSub" placeholder="inbox" autocomplete="off" spellcheck="false" />
      <small class="proj-hint">relativ zum Repo — Standard: inbox</small>
    </label>
    <div class="proj-form-actions">
      <button type="button" class="link" id="projFormCancel">abbrechen</button>
      <button type="button" class="btn-primary btn-sm" id="projFormSave">Speichern</button>
    </div>`;
  form.querySelector('#projFormFolder').addEventListener('click', async () => {
    const dir = await pickDirectory();
    if (dir) { projForm.handle = dir; updateFolderBtn(); }
  });
  form.querySelector('#projFormCancel').addEventListener('click', () => {
    const backTo = projForm.editingId;   // vor dem Reset merken
    closeProjectForm();
    focusProjectRow(backTo);             // zurück zur Zeile bzw. zum „hinzufügen"-Button
  });
  form.querySelector('#projFormSave').addEventListener('click', saveProjectForm);
  return form;
}

function buildProjectPop() {
  const pop = el.projPop;
  pop.innerHTML = '';

  // Disclosure-Muster: schlichte Liste aus echten Buttons (kein role="menu")
  const list = document.createElement('ul');
  list.className = 'proj-list';
  list.setAttribute('role', 'list');  // Semantik trotz list-style:none erhalten
  if (!projects.length) {
    const empty = document.createElement('li');
    empty.className = 'proj-empty';
    empty.textContent = 'Noch kein Projekt hinterlegt.';
    list.appendChild(empty);
  }
  projects.forEach((p) => {
    const active = p.id === draft.projectId;
    const row = document.createElement('li');
    row.className = 'proj-row' + (active ? ' active' : '');
    row.dataset.pid = p.id;

    const pick = document.createElement('button');
    pick.className = 'proj-pick'; pick.type = 'button';
    if (active) pick.setAttribute('aria-current', 'true');  // aktuelles Ziel (statt aria-checked)
    const dot = document.createElement('span');
    dot.className = 'proj-row-dot'; dot.style.background = p.color || 'var(--accent)';
    dot.setAttribute('aria-hidden', 'true');
    const texts = document.createElement('span');
    texts.className = 'proj-row-texts';
    const nm = document.createElement('span'); nm.className = 'proj-row-name'; nm.textContent = p.name;
    const sub = document.createElement('span'); sub.className = 'proj-row-sub';
    sub.textContent = `${p.handle ? p.handle.name : '—'} / ${p.subdir || 'inbox'}`;
    texts.append(nm, sub);
    const status = document.createElement('span');
    status.className = 'proj-row-status' + (p.granted ? ' ok' : '');
    status.setAttribute('aria-hidden', 'true');  // Farbe allein reicht nicht → Text folgt
    status.title = p.granted ? 'verbunden' : 'wird beim Schreiben freigegeben';
    const srStatus = document.createElement('span');
    srStatus.className = 'sr-only';
    srStatus.textContent = p.granted ? ' — verbunden' : ' — nicht verbunden';
    pick.append(dot, texts, status, srStatus);
    pick.addEventListener('click', () => selectProject(p.id));

    const edit = document.createElement('button');
    edit.className = 'proj-mini'; edit.type = 'button';
    edit.title = 'bearbeiten';
    edit.setAttribute('aria-label', `Projekt „${p.name}" bearbeiten`);
    edit.innerHTML = '<span aria-hidden="true">✎</span>';
    edit.addEventListener('click', (e) => { e.stopPropagation(); openProjectForm(p.id); });

    const del = document.createElement('button');
    del.className = 'proj-mini danger'; del.type = 'button';
    del.title = 'entfernen';
    del.setAttribute('aria-label', `Projekt „${p.name}" entfernen`);
    del.innerHTML = '<span aria-hidden="true">🗑</span>';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeProject(p.id); });

    row.append(pick, edit, del);
    list.appendChild(row);
  });

  const add = document.createElement('button');
  add.className = 'proj-add'; add.type = 'button';
  add.innerHTML = '<span class="proj-add-plus" aria-hidden="true">＋</span> Projekt hinzufügen';
  add.addEventListener('click', () => openProjectForm(null));

  pop.append(list, add, buildProjectForm());
  if (!pop.hidden) positionProjectPop();
}
function refreshProjectPop() { if (!el.projPop.hidden) buildProjectPop(); }

function updateFolderBtn() {
  const btn = el.projPop.querySelector('#projFormFolder');
  if (!btn) return;
  btn.textContent = projForm.handle ? `📁 ${projForm.handle.name}` : 'Ordner wählen …';
  // expliziter, kontextreicher Name (Emoji ist nur Dekor) — V1/B4
  btn.setAttribute('aria-label', projForm.handle ? `Repository-Ordner: ${projForm.handle.name}` : 'Repository-Ordner wählen');
  btn.classList.toggle('chosen', !!projForm.handle);
}
function openProjectForm(id) {
  const p = id ? getProject(id) : null;
  projForm = { editingId: id || null, handle: p ? p.handle : null };
  const pop = el.projPop;
  pop.querySelector('#projFormTitle').textContent = p ? 'Projekt bearbeiten' : 'Neues Projekt';
  pop.querySelector('#projFormName').value = p ? p.name : '';
  pop.querySelector('#projFormSub').value = p ? (p.subdir || '') : '';
  updateFolderBtn();
  pop.querySelector('.proj-form').hidden = false;
  pop.querySelector('#projFormName').focus();
  positionProjectPop();
}
function closeProjectForm() {
  const form = el.projPop.querySelector('.proj-form');
  if (form) form.hidden = true;
  projForm = { editingId: null, handle: null };
  positionProjectPop();
}

function onDocClickProj(e) { if (!el.projSelect.contains(e.target)) closeProjectPop(); }
function onEscProj(e) { if (e.key === 'Escape') { e.stopPropagation(); closeProjectPop(true); } }
// Tabbt der Fokus aus dem Popover heraus → schließen. relatedTarget=null (z. B. der
// native Ordner-Dialog nimmt den Fokus) NICHT schließen, sonst geht das Formular verloren.
function onFocusOutProj(e) {
  if (e.relatedTarget && !el.projSelect.contains(e.relatedTarget)) closeProjectPop();
}
// Popover ist position:fixed → am Trigger ausrichten, an Viewport-Rändern clampen
function positionProjectPop() {
  const pop = el.projPop;
  if (pop.hidden) return;
  const r = el.projBtn.getBoundingClientRect();
  const w = pop.offsetWidth || 320;
  const h = pop.offsetHeight || 0;
  let left = Math.min(r.left, window.innerWidth - w - 8);
  if (left < 8) left = 8;
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8 && r.top - 8 - h > 8) top = r.top - 8 - h;
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, top) + 'px';
}
function openProjectPop() {
  buildProjectPop();
  el.projPop.hidden = false;
  positionProjectPop();
  el.projBtn.setAttribute('aria-expanded', 'true');
  document.addEventListener('click', onDocClickProj, true);
  document.addEventListener('keydown', onEscProj, true);
  el.projSelect.addEventListener('focusout', onFocusOutProj);
  window.addEventListener('resize', positionProjectPop);
  window.addEventListener('scroll', positionProjectPop, true);
}
function closeProjectPop(focusTrigger) {
  if (el.projPop.hidden) return;
  // erst Listener entfernen, damit das Ausblenden keinen Spuren-focusout auslöst
  document.removeEventListener('click', onDocClickProj, true);
  document.removeEventListener('keydown', onEscProj, true);
  el.projSelect.removeEventListener('focusout', onFocusOutProj);
  window.removeEventListener('resize', positionProjectPop);
  window.removeEventListener('scroll', positionProjectPop, true);
  el.projPop.hidden = true;
  el.projBtn.setAttribute('aria-expanded', 'false');
  closeProjectForm();
  if (focusTrigger) el.projBtn.focus();  // Fokus-Return nur bei Tastatur (Esc/Auswahl)
}
function toggleProjectPop() { if (el.projPop.hidden) openProjectPop(); else closeProjectPop(true); }

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

  el.projBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleProjectPop(); });
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

    // Projekte laden — inkl. Migration vom alten Einzel-Ordner (rootHandle)
    let stored = await kvGet('projects');
    if (!stored) {
      const oldRoot = await kvGet('rootHandle');
      if (oldRoot) {
        stored = [{ id: uuid(), name: oldRoot.name, handle: oldRoot, subdir: 'inbox', color: PROJECT_COLORS[0] }];
        await kvSet('projects', stored);
      } else {
        stored = [];
      }
    }
    projects = stored.map((p) => ({ ...p, subdir: p.subdir || 'inbox', color: p.color || PROJECT_COLORS[0], granted: false }));

    activeProjectId = await kvGet('activeProjectId');
    if (!getProject(activeProjectId)) activeProjectId = projects[0] ? projects[0].id : null;

    // Berechtigungen still prüfen (ohne Prompt)
    for (const p of projects) { try { p.granted = await verifyPermission(p.handle, false); } catch (_) {} }

    // Tickets ohne Zuordnung dem aktiven Projekt zuschlagen (eindeutig nach Migration)
    if (activeProjectId) {
      for (const t of tickets) {
        if (t.projectId === undefined || t.projectId === null) {
          t.projectId = activeProjectId;
          await idbPut(t);
        }
      }
    }
  } catch (e) { console.error(e); }

  draft.projectId = activeProjectId;
  syncProjectSelector();
  render();
  el.title.focus();

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (_) {}
  }
}
init();
