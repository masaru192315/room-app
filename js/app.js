import { db, requestPersist, initStore, embedded } from './db.js';
import { TYPES, MOODS, PROMPTS } from './templates.js';
import { esc, wikiLinks, inlineTags } from './markdown.js';
import * as ins from './insights.js';

// =====================================================================
//  開発ノート（スマホ優先 UI）
//  画面は「ホーム」「気付き」の2つ＋全画面の「書く」画面。
//  ノートは 1行目がタイトル、本文中の #〇〇 がタグ。
// =====================================================================

// ---------- 状態 ----------
const state = { notes: [], projects: [], storage: 'local' };
const SETTINGS_KEY = 'devnote.settings';
const settings = Object.assign({ theme: 'auto', weekGoal: 3, lastProject: '', filterProject: '' }, safeJSON(safeGet(SETTINGS_KEY)));
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} }
const ui = { search: '', searching: false };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const live = () => state.notes.filter(n => !n.deletedAt);
const projectOf = id => state.projects.find(p => p.id === id);
const activeProjects = () => state.projects.filter(p => !p.archived);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const fmtDate = t => { const d = new Date(t); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
const fmtMD = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
const fmtTime = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const moodEmoji = v => MOODS.find(m => m.v === v)?.e || '';
function dayLabel(t) {
  const k = ins.dayKey(t), today = new Date();
  if (k === ins.dayKey(today)) return '今日';
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (k === ins.dayKey(y)) return '昨日';
  const d = new Date(t);
  return d.getFullYear() === today.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})` : fmtDate(t);
}

// ノートの文章（旧データの title も1行目として扱う）
const noteText = n => (n.title?.trim() ? `${n.title.trim()}\n${n.body || ''}` : (n.body || ''));
const cleanLine = l => l.replace(/^[#>\-*\s]+|\[[ xX]\]\s?/g, '').replace(/\*\*|\[\[|\]\]/g, '').trim();
function noteTitle(n) {
  const first = noteText(n).split('\n').map(cleanLine).find(Boolean);
  return first ? first.slice(0, 40) : `${TYPES[n.type]?.label || 'メモ'} ${fmtMD(n.createdAt)}`;
}
function snippet(n, len = 70) {
  const lines = noteText(n).split('\n').filter(l => cleanLine(l));
  return lines.slice(1).filter(l => !/^#{1,4}\s/.test(l)).map(cleanLine).join(' ').replace(/\s+/g, ' ').slice(0, len);
}
const allTags = n => [...new Set([...(n.tags || []), ...inlineTags(noteText(n))])];

// ---------- 画面遷移 ----------
// 通常は URL の #/... で切り替え。claude.ai のアーティファクト内では URL を使えないので内部状態で切り替える。
let currentPath = embedded ? '/home' : (location.hash.slice(1) || '/home');
const history_ = [];
function go(path, { replace = false } = {}) {
  path = path.replace(/^#/, '');
  if (!replace && currentPath !== path) history_.push(currentPath);
  if (embedded) { currentPath = path; route(); }
  else if (location.hash === '#' + path) route();
  else if (replace) { location.replace('#' + path); }
  else location.hash = path;
}
function back(fallback = '/home') {
  const prev = history_.pop();
  go(prev && !prev.startsWith('/note/') ? prev : fallback, { replace: true });
}

// ---------- 共通部品 ----------
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}
let closeSheet = null;
function sheet(html, mount, onClose) {
  closeSheet?.();
  const root = $('#sheet');
  root.innerHTML = `<div class="sheet-backdrop" data-close></div><div class="sheet-panel" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div>`;
  root.hidden = false;
  const close = () => { if (closeSheet !== close) return; closeSheet = null; root.hidden = true; root.innerHTML = ''; onClose?.(); };
  closeSheet = close;
  root.onclick = e => { if (e.target.closest('[data-close]')) close(); };
  mount?.(root, close);
  return close;
}
function ask(message, { ok = 'OK', danger = false, typeToConfirm = '' } = {}) {
  return new Promise(resolve => {
    let done = false;
    sheet(`<h3>${esc(message)}</h3>
      ${typeToConfirm ? `<label class="field"><span>確認のため「${esc(typeToConfirm)}」と入力してください</span><input id="ask-input" autocomplete="off"></label>` : ''}
      <div class="sheet-actions"><button class="btn ${danger ? 'danger' : 'primary'} block" id="ask-ok" ${typeToConfirm ? 'disabled' : ''}>${esc(ok)}</button><button class="btn ghost block" data-close>キャンセル</button></div>`, (root, closeFn) => {
      const input = $('#ask-input', root);
      if (input) { input.focus(); input.oninput = () => { $('#ask-ok', root).disabled = input.value.trim() !== typeToConfirm; }; }
      $('#ask-ok', root).onclick = () => { done = true; closeFn(); resolve(true); };
    }, () => { if (!done) resolve(false); });
  });
}
async function saveFile(name, text, type) {
  if (embedded) {
    const dl = await window.claude.use('downloads');
    if (!dl) { toast('この画面ではファイルを保存できません'); return false; }
    try { await dl.save({ filename: name, data: text }); toast('保存しました'); return true; }
    catch (e) { if (e?.code !== 'declined') toast('保存できませんでした'); return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

// 上部バー：左（戻る or ロゴ）、タイトル、右のボタン
function setBar({ title = '開発ノート', backTo = null, actions = [] } = {}) {
  const bar = $('#bar');
  bar.innerHTML = `
    ${backTo ? '<button class="bar-btn" id="bar-back" aria-label="戻る"><span class="chev">‹</span></button>' : '<span class="bar-logo" aria-hidden="true">📓</span>'}
    <h1>${esc(title)}</h1>
    ${actions.map((a, i) => `<button class="bar-btn ${a.primary ? 'bar-primary' : ''}" data-act="${i}" aria-label="${esc(a.label)}">${a.text || a.icon}</button>`).join('')}`;
  if (backTo) $('#bar-back').onclick = () => (typeof backTo === 'function' ? backTo() : back(backTo));
  actions.forEach((a, i) => { $(`[data-act="${i}"]`, bar).onclick = a.onClick; });
  document.title = title === '開発ノート' ? title : `${title} - 開発ノート`;
}
function setNav(name) { $$('.nav [data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name)); }

// ---------- 保存 ----------
function saveErrorText(e) {
  if (e?.code === 'quota_exceeded') return '保存できる量の上限に達しました。ゴミ箱を空にしてください';
  if (e?.code === 'invalid_argument') return 'この表示では保存できません（閲覧のみの権限です）';
  return '保存できませんでした。通信状態を確認してください';
}
async function saveNote(n) {
  n.updatedAt = Date.now();
  try { await db.put('notes', n); } catch (e) { console.error(e); toast(saveErrorText(e)); throw e; }
  const i = state.notes.findIndex(x => x.id === n.id);
  if (i >= 0) state.notes[i] = n; else state.notes.push(n);
}
async function saveProject(p) {
  p.updatedAt = Date.now();
  try { await db.put('projects', p); } catch (e) { console.error(e); toast(saveErrorText(e)); throw e; }
  const i = state.projects.findIndex(x => x.id === p.id);
  if (i >= 0) state.projects[i] = p; else state.projects.push(p);
}
function newNote(extra = {}) {
  const now = Date.now();
  return { id: uid(), schema: 1, type: 'memo', title: '', body: '', mood: null, tags: [], projectId: settings.filterProject || '', createdAt: now, updatedAt: now, deletedAt: null, ...extra };
}
// 新しいノートを作って書く画面へ（保存は何か書いたときだけ）
let draft = null;
function startNote(extra = {}) {
  draft = newNote(extra);
  go(`/note/${draft.id}`);
}

// ---------- ノートの行 ----------
function noteRow(n, q = '') {
  const p = projectOf(n.projectId);
  const hl = s => { const e = esc(s); if (!q) return e; const r = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); return e.replace(r, m => `<mark>${m}</mark>`); };
  let snip = snippet(n);
  if (q) { const t = noteText(n), i = t.toLowerCase().indexOf(q.toLowerCase()); if (i >= 0) snip = (i > 15 ? '…' : '') + t.slice(Math.max(0, i - 15), i + 50).replace(/\s+/g, ' '); }
  const showProject = p && !settings.filterProject;
  return `<a class="row-note" href="#/note/${n.id}">
    <span class="rn-lead">${n.mood ? moodEmoji(n.mood) : (TYPES[n.type]?.icon || '💭')}</span>
    <span class="rn-main">
      <span class="rn-title">${hl(noteTitle(n))}</span>
      ${snip ? `<span class="rn-snip">${hl(snip)}</span>` : ''}
      <span class="rn-meta">${fmtTime(n.createdAt)}${showProject ? ` · ${esc(p.name)}` : ''}${allTags(n).slice(0, 3).map(t => ` · #${esc(t)}`).join('')}</span>
    </span>
  </a>`;
}
function groupedList(notes, q = '') {
  let html = '', last = '';
  for (const n of notes) {
    const d = dayLabel(n.createdAt);
    if (d !== last) { html += `${last ? '</div>' : ''}<div class="day-head">${d}</div><div class="group">`; last = d; }
    html += noteRow(n, q);
  }
  return html + (last ? '</div>' : '');
}

// ---------- ホーム ----------
function renderHome() {
  setNav('home');
  setBar({
    title: '開発ノート',
    actions: [
      { icon: '🔍', label: '検索', onClick: () => { ui.searching = !ui.searching; if (!ui.searching) ui.search = ''; renderHome(); if (ui.searching) $('#q')?.focus(); } },
      { icon: '⚙️', label: '設定', onClick: () => go('/settings') },
    ],
  });
  const fp = settings.filterProject && projectOf(settings.filterProject) ? settings.filterProject : '';
  const proj = projectOf(fp);
  const q = ui.search.trim().toLowerCase();
  const notes = live()
    .filter(n => !fp || n.projectId === fp)
    .filter(n => !q || `${noteText(n)}\n${allTags(n).join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);
  const empty = live().length === 0;

  view.innerHTML = `
  ${ui.searching ? `<div class="search"><input id="q" type="search" placeholder="ことば・#タグで探す" value="${esc(ui.search)}" autocomplete="off" enterkeyhint="search"></div>` : ''}
  <div class="pchips" role="tablist" aria-label="プロジェクト">
    <button class="pchip ${!fp ? 'on' : ''}" data-p="">すべて</button>
    ${activeProjects().map(p => `<button class="pchip ${fp === p.id ? 'on' : ''}" data-p="${p.id}">${esc(p.name)}</button>`).join('')}
    <button class="pchip add" id="add-project" aria-label="プロジェクトを追加">＋ アプリ</button>
  </div>
  ${proj ? `<a class="purpose" href="#/project/${proj.id}">
      <span class="purpose-label">🎯 目的</span>
      <span class="purpose-text">${proj.purpose ? esc(proj.purpose) : 'まだ書かれていません。タップして「なぜ作るのか」を書いておこう'}</span>
      <span class="purpose-more">経緯を見る ›</span></a>` : ''}
  ${empty ? `<div class="empty">
      <div class="empty-icon">📝</div>
      <p class="empty-title">はじめの1行を書いてみよう</p>
      <p class="muted">下の <b>＋</b> を押すとすぐ書けます。<br>作っているアプリは上の「＋ アプリ」から登録できます。</p>
    </div>` : notes.length ? groupedList(notes, ui.search.trim()) : `<p class="muted center pad">${q ? '見つかりませんでした' : 'このアプリのノートはまだありません'}</p>`}`;

  $$('.pchip[data-p]', view).forEach(b => b.onclick = () => { settings.filterProject = b.dataset.p; saveSettings(); renderHome(); });
  $('#add-project').onclick = () => openProjectSheet();
  const qi = $('#q');
  if (qi) qi.oninput = e => { ui.search = e.target.value; const pos = qi.selectionStart; renderHome(); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); };
}

// ---------- 書く画面 ----------
let leaveEditor = null, flushEditor = null;
function findByTitle(title) {
  const t = title.trim().toLowerCase();
  return live().find(n => noteTitle(n).toLowerCase() === t);
}

function renderEditor(id) {
  let n = state.notes.find(x => x.id === id) || (draft?.id === id ? draft : null);
  if (!n) { go('/home', { replace: true }); return; }
  const isNew = !state.notes.includes(n);
  setNav('');
  const p = projectOf(n.projectId);

  let text = noteText(n);
  view.innerHTML = `
  <div class="ed">
    ${n.deletedAt ? `<div class="banner">ゴミ箱にあるノートです <button class="btn small" id="restore">元に戻す</button></div>` : ''}
    <div class="ed-moods" role="radiogroup" aria-label="気分">${MOODS.map(m => `<button class="mood ${n.mood === m.v ? 'on' : ''}" data-mood="${m.v}" role="radio" aria-checked="${n.mood === m.v}" aria-label="${m.l}"><span>${m.e}</span><small>${m.l}</small></button>`).join('')}</div>
    <textarea id="ed-text" class="ed-text" placeholder="思ったこと・やったことを書く&#10;（1行目がタイトルになります）" enterkeyhint="enter">${esc(text)}</textarea>
    <div id="templates" class="templates" ${text.trim() ? 'hidden' : ''}>
      <p class="muted small">テンプレートを使う</p>
      <div class="tpl-row">${Object.entries(TYPES).filter(([k]) => k !== 'memo').map(([k, t]) => `<button class="tpl" data-tpl="${k}"><span>${t.icon}</span>${t.label}</button>`).join('')}</div>
    </div>
    <div class="ed-info">
      <button class="info-chip" id="pick-project">🚀 ${p ? esc(p.name) : 'アプリを選ぶ'}</button>
      <span class="muted small">${fmtDate(n.createdAt)} ${fmtTime(n.createdAt)}</span>
    </div>
    <p class="hint muted small">ヒント：<b>#タグ</b> で分類、<b>[[ノート名]]</b> で他のノートとつながる、<b>- [ ]</b> でやること</p>
    <div id="links"></div>
    ${!isNew ? `<div class="ed-danger">${n.deletedAt ? '<button class="btn danger block" id="purge">完全に削除</button>' : '<button class="btn ghost block" id="del">🗑 このノートを削除</button>'}</div>` : ''}
  </div>`;

  const ta = $('#ed-text');
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight + 2, window.innerHeight * 0.38) + 'px'; };
  let timer = null, dirty = false;
  const hasContent = () => ta.value.trim() || n.mood;
  const persist = async () => {
    clearTimeout(timer); timer = null;
    if (!dirty) return;
    dirty = false;
    n.title = ''; n.body = ta.value;
    if (!state.notes.includes(n) && !hasContent()) return; // 空の新規ノートは保存しない
    await saveNote(n); draft = null;
    setBar(barOpts());
    drawLinks();
  };
  const schedule = () => { dirty = true; clearTimeout(timer); timer = setTimeout(persist, 600); };

  const barOpts = () => ({
    title: state.notes.includes(n) ? '保存済み' : '新しいノート',
    backTo: async () => { await persist(); back('/home'); },
    actions: [{ text: '完了', label: '完了', primary: true, onClick: async () => { ta.blur(); await persist(); back('/home'); } }],
  });
  setBar(barOpts());

  ta.oninput = () => { grow(); schedule(); $('#templates').hidden = !!ta.value.trim(); };
  $$('.mood', view).forEach(b => b.onclick = () => {
    n.mood = n.mood === +b.dataset.mood ? null : +b.dataset.mood;
    $$('.mood', view).forEach(x => { const on = +x.dataset.mood === n.mood; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
    dirty = true; persist();
  });
  $$('.tpl', view).forEach(b => b.onclick = () => {
    const t = TYPES[b.dataset.tpl];
    n.type = b.dataset.tpl;
    ta.value = `# ${t.label} ${fmtMD(n.createdAt)}\n\n${t.body}`;
    $('#templates').hidden = true; grow(); schedule();
    ta.focus(); const pos = ta.value.indexOf('- ') + 2; if (pos > 1) ta.setSelectionRange(pos, pos);
  });
  $('#pick-project').onclick = () => pickProject(n.projectId, async pid => {
    n.projectId = pid; settings.lastProject = pid; saveSettings();
    $('#pick-project').textContent = `🚀 ${projectOf(pid)?.name || 'アプリを選ぶ'}`;
    dirty = true; await persist();
  });
  $('#del')?.addEventListener('click', async () => {
    if (!await ask('このノートを削除しますか？', { ok: '削除する', danger: true })) return;
    n.deletedAt = Date.now(); dirty = true; await persist(); toast('削除しました（設定のゴミ箱から戻せます）'); back('/home');
  });
  $('#restore')?.addEventListener('click', async () => { n.deletedAt = null; dirty = true; await persist(); renderEditor(id); toast('元に戻しました'); });
  $('#purge')?.addEventListener('click', async () => {
    if (!await ask('完全に削除しますか？元に戻せません。', { ok: '完全に削除', danger: true })) return;
    await db.del('notes', n.id); state.notes = state.notes.filter(x => x.id !== n.id); back('/settings');
  });

  // [[リンク]] とバックリンク
  function drawLinks() {
    const out = [...new Set(wikiLinks(ta.value))];
    const me = noteTitle(n).toLowerCase();
    const backs = live().filter(x => x.id !== n.id && wikiLinks(noteText(x)).some(t => t.toLowerCase() === me));
    $('#links').innerHTML =
      (out.length ? `<p class="muted small">このノートからのリンク</p><div class="link-row">${out.map(t => `<button class="link-chip" data-link="${esc(t)}">${findByTitle(t) ? '🔗' : '＋'} ${esc(t)}</button>`).join('')}</div>` : '') +
      (backs.length ? `<p class="muted small">このノートを参照しているノート</p><div class="group">${backs.map(x => noteRow(x)).join('')}</div>` : '');
    $$('.link-chip', view).forEach(b => b.onclick = async () => {
      await persist();
      const hit = findByTitle(b.dataset.link);
      if (hit) go(`/note/${hit.id}`);
      else { startNote({ body: `${b.dataset.link}\n`, projectId: n.projectId }); }
    });
  }
  drawLinks();

  grow();
  if (isNew) setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 50);

  flushEditor = () => timer && persist();
  leaveEditor = async () => { flushEditor = null; if (timer) await persist(); if (draft === n) draft = null; };
}

// ---------- プロジェクト ----------
function pickProject(current, onPick) {
  sheet(`<h3>どのアプリのノート？</h3>
    <div class="pick-list">
      <button class="pick ${!current ? 'on' : ''}" data-pid="">指定しない</button>
      ${activeProjects().map(p => `<button class="pick ${current === p.id ? 'on' : ''}" data-pid="${p.id}">🚀 ${esc(p.name)}</button>`).join('')}
      <button class="pick add" id="pick-new">＋ 新しいアプリを登録</button>
    </div>`, (root, close) => {
    $$('[data-pid]', root).forEach(b => b.onclick = () => { close(); onPick(b.dataset.pid); });
    $('#pick-new', root).onclick = () => openProjectSheet(null, p => onPick(p.id));
  });
}

function openProjectSheet(p = null, onSaved = null) {
  sheet(`<h3>${p ? 'アプリを編集' : '作っているアプリを登録'}</h3>
    <label class="field"><span>アプリ名</span><input id="p-name" value="${esc(p?.name || '')}" placeholder="例: 家計簿アプリ" enterkeyhint="next"></label>
    <label class="field"><span>目的（なぜ作る？誰のため？）</span><textarea id="p-purpose" rows="4" placeholder="例: 支出を3秒で記録したい。今のアプリは入力が面倒で続かなかったから。">${esc(p?.purpose || '')}</textarea></label>
    <div class="sheet-actions"><button class="btn primary block" id="p-save">保存</button><button class="btn ghost block" data-close>キャンセル</button></div>`, (root, close) => {
    setTimeout(() => $('#p-name', root)?.focus(), 50);
    $('#p-save', root).onclick = async () => {
      const name = $('#p-name', root).value.trim();
      if (!name) { $('#p-name', root).focus(); toast('アプリ名を入れてください'); return; }
      const proj = p || { id: uid(), schema: 1, createdAt: Date.now(), archived: false };
      proj.name = name; proj.purpose = $('#p-purpose', root).value.trim();
      await saveProject(proj);
      close();
      if (onSaved) { onSaved(proj); return; }
      if (!p) { settings.filterProject = proj.id; saveSettings(); toast(`「${name}」を登録しました`); }
      route();
    };
  });
}

function renderProject(id) {
  const p = projectOf(id);
  if (!p) { go('/home', { replace: true }); return; }
  setNav('home');
  setBar({ title: p.name, backTo: '/home', actions: [{ text: '編集', label: '編集', onClick: () => openProjectSheet(p) }] });
  const ns = live().filter(n => n.projectId === id).sort((a, b) => a.createdAt - b.createdAt);
  const first = ns[0]?.createdAt || p.createdAt;
  const elapsed = Math.max(1, Math.ceil((Date.now() - first) / 864e5));
  const moods = ns.filter(n => n.mood).map(n => n.mood);

  let tl = '', lastMonth = '';
  for (const n of [...ns].reverse()) {
    const d = new Date(n.createdAt), m = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    if (m !== lastMonth) { tl += `<div class="tl-month">${m}</div>`; lastMonth = m; }
    tl += `<a class="tl-item t-${n.type}" href="#/note/${n.id}">
      <span class="tl-dot">${n.mood ? moodEmoji(n.mood) : TYPES[n.type]?.icon || '💭'}</span>
      <span class="tl-body"><span class="tl-date">${fmtMD(n.createdAt)} ${fmtTime(n.createdAt)}</span>
      <span class="tl-title">${esc(noteTitle(n))}</span></span></a>`;
  }
  view.innerHTML = `
  <section class="card purpose-card">
    <p class="purpose-label">🎯 目的</p>
    <p>${p.purpose ? esc(p.purpose).replace(/\n/g, '<br>') : '<span class="muted">まだ書かれていません。右上の「編集」から書けます。</span>'}</p>
  </section>
  <div class="stats">
    <div><b>${elapsed}</b><small>日目</small></div>
    <div><b>${ns.length}</b><small>ノート</small></div>
    <div><b>${moods.length ? (moods.reduce((a, b) => a + b, 0) / moods.length).toFixed(1) : '-'}</b><small>平均の気分</small></div>
  </div>
  <section class="card">
    <h3>🧭 これまでの経緯</h3>
    <div class="timeline">${tl || '<p class="muted">まだノートがありません。＋ から最初の1行を書いてみよう。</p>'}</div>
  </section>
  <button class="btn ghost block" id="p-archive">${p.archived ? '進行中に戻す' : '完成・お休み中にする（一覧から隠す）'}</button>`;
  $('#p-archive').onclick = async () => {
    p.archived = !p.archived; await saveProject(p);
    if (p.archived && settings.filterProject === p.id) { settings.filterProject = ''; saveSettings(); }
    toast(p.archived ? 'お休み中にしました' : '進行中に戻しました'); renderProject(id);
  };
}

// ---------- 気付き ----------
function heatmap(notes, weeks = 20) {
  const counts = ins.countByDay(notes);
  const start = ins.weekStart(); start.setDate(start.getDate() - (weeks - 1) * 7);
  const today = ins.dayKey(new Date()), now = new Date();
  let cells = '';
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 7; d++) {
    const day = new Date(start); day.setDate(start.getDate() + w * 7 + d);
    const k = ins.dayKey(day), c = counts.get(k) || 0;
    const lv = c === 0 ? 0 : c === 1 ? 1 : c <= 3 ? 2 : 3;
    cells += `<i class="hm l${lv}${k === today ? ' today' : ''}${day > now ? ' future' : ''}" style="grid-column:${w + 1};grid-row:${d + 1}"></i>`;
  }
  return `<div class="heatmap" style="grid-template-columns:repeat(${weeks},1fr)" role="img" aria-label="直近${weeks}週の記録">${cells}</div>`;
}
function moodChart(series) {
  const W = 320, H = 110, L = 22, R = 6, T = 8, B = 8;
  const x = i => L + i * (W - L - R) / (series.length - 1), y = v => T + (5 - v) * (H - T - B) / 4;
  let path = '', pen = false;
  series.forEach((s, i) => { if (s.avg == null) { pen = false; return; } path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.avg).toFixed(1)} `; pen = true; });
  const dots = series.map((s, i) => s.avg == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(s.avg).toFixed(1)}" r="3"/>`).join('');
  const grid = [1, 3, 5].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="0" y="${y(v) + 4}">${moodEmoji(v)}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="直近30日の気分"><g class="grid">${grid}</g><path d="${path}"/>${dots}</svg>
    <div class="chart-x muted small"><span>30日前</span><span>今日</span></div>`;
}

function renderInsights() {
  setNav('insights');
  setBar({ title: '気付き', actions: [{ icon: '⚙️', label: '設定', onClick: () => go('/settings') }] });
  const notes = live();
  const goal = settings.weekGoal, days = ins.daysThisWeek(notes), streak = ins.weekStreak(notes, goal);
  const promptIdx = Math.floor(Date.now() / 864e5) % PROMPTS.length;
  const otd = ins.onThisDay(notes);
  const series = ins.moodSeries(notes, 30);
  const tm = ins.tagMood(notes.map(n => ({ ...n, tags: allTags(n) })));
  const words = ins.topWords(notes.filter(n => n.createdAt > Date.now() - 30 * 864e5).map(n => ({ ...n, title: '', body: noteText(n) })));
  const tasks = ins.openTasks(notes.map(n => ({ ...n, body: noteText(n) })));
  const weekAgo = Date.now() - 7 * 864e5;
  const week = notes.filter(n => n.createdAt > weekAgo && n.mood);
  const best = [...week].sort((a, b) => b.mood - a.mood)[0], worst = [...week].sort((a, b) => a.mood - b.mood)[0];

  view.innerHTML = `
  <section class="card">
    <div class="card-head"><h3>🌿 記録した日</h3><span class="goal">今週 <b>${days}</b>/${goal}日</span></div>
    ${heatmap(notes)}
    <p class="muted small">${days >= goal ? `今週の目標達成！${streak > 1 ? `（${streak}週連続）` : ''}` : days === 0 ? '今週はまだ。1行だけでも大丈夫。' : `あと${goal - days}日で今週の目標。`}</p>
  </section>

  <section class="card prompt-card">
    <h3>💡 今日の問い</h3>
    <p class="prompt" id="prompt-text" data-idx="${promptIdx}">${PROMPTS[promptIdx]}</p>
    <div class="btn-row"><button class="btn primary" id="answer">これに答える</button><button class="btn ghost" id="next-prompt">別の問い</button></div>
  </section>

  ${otd.length ? `<section class="card"><h3>⏳ 過去の今日</h3>${otd.map(g => `<p class="otd-label">${g.label}</p><div class="group flat">${g.notes.map(n => noteRow(n)).join('')}</div>`).join('')}</section>` : ''}

  ${best && worst && best.mood > worst.mood ? `<section class="card">
    <h3>📅 この1週間の振れ幅</h3>
    <p class="muted small">いちばん良かった時</p><div class="group flat">${noteRow(best)}</div>
    <p class="muted small">いちばんしんどかった時</p><div class="group flat">${noteRow(worst)}</div>
    <p class="small">→ 2つの違いは何だろう？</p>
  </section>` : ''}

  <section class="card">
    <h3>📈 気分の流れ（30日）</h3>
    ${series.some(s => s.avg != null) ? moodChart(series) : '<p class="muted">ノートに気分を付けると、ここにグラフが出ます。</p>'}
  </section>

  ${tm.length ? `<section class="card">
    <h3>🏷 タグと気分</h3>
    <p class="muted small">そのタグが付いた日の気分は平均より…（関係があるだけで、原因とは限りません）</p>
    <div class="bars">${tm.slice(0, 8).map(t => `<div class="bar-row"><span class="bar-label">#${esc(t.tag)}</span><span class="bar-track"><span class="bar ${t.diff >= 0 ? 'pos' : 'neg'}" style="width:${Math.min(100, Math.abs(t.diff) * 50)}%"></span></span><span class="bar-val">${t.diff >= 0 ? '+' : ''}${t.diff.toFixed(1)}</span></div>`).join('')}</div>
  </section>` : ''}

  ${words.length ? `<section class="card">
    <h3>💬 最近よく書く言葉</h3>
    <div class="chips">${words.slice(0, 15).map(([w, c]) => `<button class="chip word" data-w="${esc(w)}">${esc(w)} <small>${c}</small></button>`).join('')}</div>
    <p class="muted small">タップするとその言葉で検索します</p>
  </section>` : ''}

  <section class="card">
    <h3>✅ まだやっていないこと</h3>
    ${tasks.length ? `<ul class="task-list">${tasks.slice(0, 30).map((t, i) => `<li><label><input type="checkbox" data-i="${i}"><span>${esc(t.text)}</span></label><small class="muted">${fmtMD(t.note.createdAt)} · ${esc(noteTitle(t.note).slice(0, 18))}</small></li>`).join('')}</ul>`
      : '<p class="muted">ノートに <b>- [ ] やること</b> と書くと、ここに集まります。</p>'}
  </section>

  <button class="btn ghost block" id="write-weekly">🔁 週のふりかえりを書く</button>`;

  $('#answer').onclick = () => startNote({ body: `# ${PROMPTS[+$('#prompt-text').dataset.idx]}\n\n` });
  $('#next-prompt').onclick = () => {
    const el = $('#prompt-text'), i = (+el.dataset.idx + 1 + Math.floor(Math.random() * (PROMPTS.length - 1))) % PROMPTS.length;
    el.dataset.idx = i; el.textContent = PROMPTS[i];
  };
  $('#write-weekly').onclick = () => startNote({ type: 'weekly', body: `# ${TYPES.weekly.label} ${fmtMD(Date.now())}\n\n${TYPES.weekly.body}` });
  $$('.word', view).forEach(b => b.onclick = () => { ui.searching = true; ui.search = b.dataset.w; settings.filterProject = ''; go('/home'); });
  $$('.task-list input', view).forEach(cb => cb.onchange = async () => {
    const t = tasks[+cb.dataset.i];
    const n = state.notes.find(x => x.id === t.note.id);
    const lines = noteText(n).split('\n');
    lines[t.line] = lines[t.line].replace('[ ]', '[x]');
    n.title = ''; n.body = lines.join('\n');
    await saveNote(n);
    cb.closest('li').classList.add('done');
    toast('できた！ 🎉');
  });
}

// ---------- 設定 ----------
function toMarkdown() {
  const out = [`# 開発ノート (${fmtDate(Date.now())})\n`];
  for (const p of state.projects) out.push(`\n## 🚀 ${p.name}\n\n> ${(p.purpose || '').replace(/\n/g, '\n> ')}\n`);
  for (const n of live().sort((a, b) => a.createdAt - b.createdAt)) {
    const p = projectOf(n.projectId);
    const meta = [`${fmtDate(n.createdAt)} ${fmtTime(n.createdAt)}`, p && p.name, n.mood && `${moodEmoji(n.mood)} ${MOODS[n.mood - 1].l}`].filter(Boolean).join(' · ');
    out.push(`\n---\n\n### ${noteTitle(n)}\n\n_${meta}_\n\n${noteText(n).replace(/^(#{1,4})\s/gm, '$1## ')}\n`);
  }
  return out.join('');
}

async function renderSettings() {
  setNav('');
  setBar({ title: '設定', backTo: '/home' });
  const trash = state.notes.filter(n => n.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  const archived = state.projects.filter(p => p.archived);
  const onClaude = state.storage === 'claude';
  const storageText = onClaude
    ? 'あなたの Claude アカウントに保存されています（本人だけが見られます）。パソコンでもスマホでも同じノートが見られます。'
    : 'この端末のブラウザ内に保存されています。<b>ときどきバックアップしてください。</b>特にiPhoneでは、ブラウザがデータを消すことがあります。';

  view.innerHTML = `
  <section class="card">
    <h3>表示</h3>
    <div class="seg" id="theme">${[['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']].map(([v, l]) => `<button data-v="${v}" class="${settings.theme === v ? 'on' : ''}">${l}</button>`).join('')}</div>
  </section>
  <section class="card">
    <h3>週の目標</h3>
    <p class="muted small">毎日でなくてOK。週に何日書くか決めておくと続けやすくなります。</p>
    <div class="seg" id="goal">${[1, 2, 3, 4, 5, 7].map(v => `<button data-v="${v}" class="${settings.weekGoal === v ? 'on' : ''}">${v}日</button>`).join('')}</div>
  </section>
  <section class="card">
    <h3>データ</h3>
    <p class="muted small">${storageText}</p>
    <div class="list-btns">
      <button class="list-btn" id="exp-json">バックアップを保存（JSON）<span>›</span></button>
      <button class="list-btn" id="exp-md">文章として書き出す（Markdown）<span>›</span></button>
      <label class="list-btn">バックアップから戻す<span>›</span><input type="file" id="imp" accept="application/json,.json" hidden></label>
    </div>
  </section>
  ${archived.length ? `<section class="card"><h3>お休み中のアプリ</h3><div class="list-btns">${archived.map(p => `<a class="list-btn" href="#/project/${p.id}">🚀 ${esc(p.name)}<span>›</span></a>`).join('')}</div></section>` : ''}
  <section class="card">
    <h3>ゴミ箱（${trash.length}）</h3>
    ${trash.length ? `<div class="group flat">${trash.map(n => noteRow(n)).join('')}</div><button class="btn danger small" id="empty-trash">ゴミ箱を空にする</button>` : '<p class="muted small">空です</p>'}
  </section>
  <section class="card">
    <h3>このアプリについて</h3>
    <p class="small">作っているアプリの経緯・目的・感想を記録して、振り返りから気付きを得るためのノートです。無料・広告なし。</p>
    <button class="link-btn danger" id="wipe">すべてのデータを削除</button>
  </section>`;

  $$('#theme button').forEach(b => b.onclick = () => { settings.theme = b.dataset.v; saveSettings(); applyTheme(); renderSettings(); });
  $$('#goal button').forEach(b => b.onclick = () => { settings.weekGoal = +b.dataset.v; saveSettings(); renderSettings(); });
  const stamp = new Date().toISOString().slice(0, 10);
  $('#exp-json').onclick = () => saveFile(`devnote-backup-${stamp}.json`, JSON.stringify({ app: 'devnote', version: 1, exportedAt: Date.now(), projects: state.projects, notes: state.notes }, null, 2), 'application/json');
  $('#exp-md').onclick = () => saveFile(`devnote-${stamp}.md`, toMarkdown(), 'text/markdown');
  $('#imp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'devnote' || !Array.isArray(data.notes)) throw new Error('開発ノートのバックアップではありません');
      // 同じノートは更新日時が新しい方を残す
      const merge = (cur, inc) => { const m = new Map(cur.map(x => [x.id, x])); const changed = []; for (const x of inc) { const o = m.get(x.id); if (!o || (x.updatedAt || 0) > (o.updatedAt || 0)) { m.set(x.id, x); changed.push(x); } } return [[...m.values()], changed]; };
      const [ps, pc] = merge(state.projects, data.projects || []);
      const [ns, nc] = merge(state.notes, data.notes);
      await db.bulkPut('projects', pc); await db.bulkPut('notes', nc);
      state.projects = ps; state.notes = ns;
      toast(`戻しました（ノート${nc.length}件）`);
      renderSettings();
    } catch (err) { toast('読み込めませんでした: ' + err.message); }
  };
  $('#empty-trash')?.addEventListener('click', async () => {
    if (!await ask(`ゴミ箱の${trash.length}件を完全に削除しますか？`, { ok: '完全に削除', danger: true })) return;
    for (const n of trash) await db.del('notes', n.id);
    state.notes = state.notes.filter(n => !n.deletedAt); renderSettings();
  });
  $('#wipe').onclick = async () => {
    if (!await ask('すべてのノートとアプリを削除します。先にバックアップを取りましたか？', { ok: 'すべて削除', danger: true, typeToConfirm: '削除' })) return;
    await db.clear('notes'); await db.clear('projects'); state.notes = []; state.projects = []; settings.filterProject = ''; saveSettings(); toast('削除しました'); go('/home');
  };
}

// ---------- テーマ ----------
const hostTheme = document.documentElement.getAttribute('data-theme'); // claude.ai が指定したテーマ
function applyTheme() {
  const t = settings.theme;
  if (t !== 'auto') document.documentElement.dataset.theme = t;
  else if (hostTheme) document.documentElement.dataset.theme = hostTheme;
  else document.documentElement.removeAttribute('data-theme');
}

// ---------- ルーティング ----------
async function route() {
  if (leaveEditor) { const f = leaveEditor; leaveEditor = null; await f(); }
  if (!embedded) currentPath = location.hash.slice(1) || '/home';
  closeSheet?.();
  const [, name, id] = currentPath.split('?')[0].split('/');
  document.body.dataset.view = name || 'home';
  window.scrollTo(0, 0);
  switch (name) {
    case 'note': renderEditor(id); break;
    case 'project': renderProject(id); break;
    case 'insights': renderInsights(); break;
    case 'settings': await renderSettings(); break;
    default: renderHome();
  }
}

async function init() {
  applyTheme();
  document.body.classList.toggle('embedded', embedded);
  view.innerHTML = '<p class="muted center pad">読み込み中…</p>';
  state.storage = await initStore();
  try {
    [state.notes, state.projects] = await Promise.all([db.all('notes'), db.all('projects')]);
  } catch (e) {
    console.error(e);
    view.innerHTML = '<div class="card"><h3>データを読み込めませんでした</h3><p class="muted">通信状態を確認して、開き直してください。</p></div>';
    return;
  }
  state.projects.sort((a, b) => a.createdAt - b.createdAt);
  if (state.storage === 'local-fallback') setTimeout(() => toast('この画面では Claude に保存できないため、この端末に保存します'), 600);
  if (!embedded) window.addEventListener('hashchange', route);
  // #/... へのリンクは go() で処理（アーティファクト内でも動くように）
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#/"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    e.preventDefault(); go(a.getAttribute('href'));
  });
  $('#fab').onclick = () => startNote(currentPath.startsWith('/project/') ? { projectId: currentPath.split('/')[2] } : {});
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && closeSheet) closeSheet(); });
  window.addEventListener('pagehide', () => flushEditor?.());
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushEditor?.(); });
  route();
  if (state.notes.length > 5) requestPersist();
  if (!embedded && 'serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
}
init();
