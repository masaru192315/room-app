import { db, requestPersist } from './db.js';
import { TYPES, MOODS, PROMPTS } from './templates.js';
import { render, esc, wikiLinks, inlineTags } from './markdown.js';
import * as ins from './insights.js';

// ---------- 状態 ----------
const state = { notes: [], projects: [] };
const SETTINGS_KEY = 'devnote.settings';
const settings = Object.assign({ theme: 'auto', weekGoal: 3, lastProject: '' }, safeJSON(localStorage.getItem(SETTINGS_KEY)));
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} }

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const live = () => state.notes.filter(n => !n.deletedAt);
const projectOf = id => state.projects.find(p => p.id === id);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const fmtDate = t => { const d = new Date(t); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
const fmtTime = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fmtShort = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(t)}`; };
const moodEmoji = v => MOODS.find(m => m.v === v)?.e || '';

export function noteTitle(n) {
  if (n.title?.trim()) return n.title.trim();
  const first = (n.body || '').split('\n').map(l => l.replace(/^[#>\-*\s]+|\[[ xX]\]\s?/g, '').trim()).find(Boolean);
  return first ? first.slice(0, 40) : `${TYPES[n.type]?.label || 'メモ'} ${fmtDate(n.createdAt)}`;
}
const allTags = n => [...new Set([...(n.tags || []), ...inlineTags(n.body)])];
const snippet = (n, len = 80) => (n.body || '').replace(/^#+\s.*$/gm, '').replace(/[-*]\s\[[ xX]\]|^\s*[-*]\s|^\s*\d+\.\s/gm, '').replace(/\*\*|~~|`|\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim().slice(0, len);

// ---------- 保存 ----------
async function saveNote(n) {
  n.updatedAt = Date.now();
  await db.put('notes', n);
  const i = state.notes.findIndex(x => x.id === n.id);
  if (i >= 0) state.notes[i] = n; else state.notes.push(n);
}
async function saveProject(p) {
  p.updatedAt = Date.now();
  await db.put('projects', p);
  const i = state.projects.findIndex(x => x.id === p.id);
  if (i >= 0) state.projects[i] = p; else state.projects.push(p);
}
function newNote(type = 'memo', extra = {}) {
  const now = Date.now();
  return { id: uid(), schema: 1, type, title: '', body: TYPES[type]?.body || '', mood: null, tags: [], projectId: settings.lastProject || '', createdAt: now, updatedAt: now, deletedAt: null, ...extra };
}

// ---------- UI 部品 ----------
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}
function sheet(html, mount) {
  const root = $('#sheet');
  root.innerHTML = `<div class="sheet-backdrop" data-close></div><div class="sheet-panel" role="dialog" aria-modal="true">${html}</div>`;
  root.hidden = false;
  const close = () => { root.hidden = true; root.innerHTML = ''; };
  root.onclick = e => { if (e.target.closest('[data-close]')) close(); };
  mount?.(root, close);
  return close;
}
const projectOptions = (sel, empty = 'プロジェクトなし') => `<option value="">${empty}</option>` + state.projects.filter(p => !p.archived || p.id === sel).map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
function setTitle(t) { $('#title').textContent = t; document.title = t === '開発ノート' ? t : `${t} - 開発ノート`; }
function setNav(name) { $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === name)); }

function noteItem(n, q = '') {
  const p = projectOf(n.projectId);
  const hl = s => { const e = esc(s); if (!q) return e; const r = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); return e.replace(r, m => `<mark>${m}</mark>`); };
  let snip = snippet(n);
  if (q) { const i = (n.body || '').toLowerCase().indexOf(q.toLowerCase()); if (i >= 0) snip = (i > 20 ? '…' : '') + n.body.slice(Math.max(0, i - 20), i + 60).replace(/\s+/g, ' '); }
  return `<a class="note-item" href="#/note/${n.id}">
    <span class="ni-icon">${TYPES[n.type]?.icon || '💭'}</span>
    <span class="ni-main">
      <span class="ni-title">${hl(noteTitle(n))}</span>
      ${snip ? `<span class="ni-snip">${hl(snip)}</span>` : ''}
      <span class="ni-meta">${fmtShort(n.createdAt)}${p ? ` · ${esc(p.name)}` : ''}${allTags(n).map(t => ` <span class="tag">#${esc(t)}</span>`).join('')}</span>
    </span>
    ${n.mood ? `<span class="ni-mood" title="${MOODS[n.mood - 1].l}">${moodEmoji(n.mood)}</span>` : ''}
  </a>`;
}

function openNewNoteSheet(extra = {}) {
  sheet(`<h3>どんなノートを書く？</h3>
    <div class="type-grid">${Object.entries(TYPES).map(([k, t]) => `<button class="type-card" data-type="${k}"><span class="tc-icon">${t.icon}</span><span class="tc-label">${t.label}</span><span class="tc-hint">${t.hint}</span></button>`).join('')}</div>
    <button class="btn ghost block" data-close>キャンセル</button>`, (root, close) => {
    $$('.type-card', root).forEach(b => b.onclick = async () => {
      const n = newNote(b.dataset.type, extra);
      await saveNote(n);
      close();
      location.hash = `#/note/${n.id}?new=1`;
    });
  });
}

// ---------- ホーム ----------
function heatmap(notes, weeks = 18) {
  const counts = ins.countByDay(notes);
  const start = ins.weekStart(); start.setDate(start.getDate() - (weeks - 1) * 7);
  const today = ins.dayKey(new Date());
  let cells = '';
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 7; d++) {
    const day = new Date(start); day.setDate(start.getDate() + w * 7 + d);
    const k = ins.dayKey(day);
    const future = day > new Date();
    const c = counts.get(k) || 0;
    const lv = c === 0 ? 0 : c === 1 ? 1 : c <= 3 ? 2 : 3;
    cells += `<i class="hm l${lv}${k === today ? ' today' : ''}${future ? ' future' : ''}" style="grid-column:${w + 1};grid-row:${d + 1}" title="${k}: ${c}件"></i>`;
  }
  return `<div class="heatmap" style="grid-template-columns:repeat(${weeks},1fr)">${cells}</div>`;
}

function renderHome() {
  setTitle('開発ノート'); setNav('home');
  const notes = live();
  const promptIdx = Math.floor(Date.now() / 864e5) % PROMPTS.length;
  const goal = settings.weekGoal;
  const days = ins.daysThisWeek(notes);
  const streak = ins.weekStreak(notes, goal);
  const otd = ins.onThisDay(notes);
  const recent = [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const activeProjects = state.projects.filter(p => !p.archived);

  view.innerHTML = `
  <section class="card capture">
    <div class="mood-row" role="radiogroup" aria-label="今の気分">${MOODS.map(m => `<button class="mood" data-mood="${m.v}" role="radio" aria-checked="false" title="${m.l}"><span>${m.e}</span><small>${m.l}</small></button>`).join('')}</div>
    <textarea id="qc-text" rows="2" placeholder="いま何してる？ 思ったことを1行で（Ctrl+Enterで記録）"></textarea>
    <div class="row">
      <select id="qc-project" aria-label="プロジェクト">${projectOptions(settings.lastProject)}</select>
      <button class="btn primary" id="qc-save">記録する</button>
    </div>
  </section>

  ${state.projects.length === 0 ? `<section class="card welcome">
    <h3>👋 はじめに</h3>
    <p>まずは作っているアプリを「プロジェクト」として登録して、<b>なぜ作るのか（目的）</b>を書いておきましょう。あとで振り返ったときの軸になります。</p>
    <button class="btn primary" id="first-project">プロジェクトを作る</button>
  </section>` : ''}

  <section class="card">
    <div class="card-head"><h3>💡 今日の問い</h3><button class="link-btn" id="next-prompt">別の問い</button></div>
    <p class="prompt" id="prompt-text" data-idx="${promptIdx}">${PROMPTS[promptIdx]}</p>
    <button class="btn" id="answer-prompt">この問いで書く</button>
  </section>

  <section class="card">
    <div class="card-head"><h3>🌿 記録の草</h3><span class="muted">今週 <b>${days}</b> / ${goal} 日${streak > 0 ? ` · 目標達成 ${streak}週連続` : ''}</span></div>
    ${heatmap(notes)}
    <p class="muted small">${days >= goal ? '今週の目標達成！無理せずいきましょう。' : days === 0 ? '今週はまだ記録なし。1行だけでも大丈夫。' : `あと${goal - days}日で今週の目標。`}</p>
  </section>

  ${otd.length ? `<section class="card">
    <h3>⏳ 過去の今日</h3>
    ${otd.map(g => `<div class="otd"><div class="otd-label">${g.label}</div>${g.notes.map(n => noteItem(n)).join('')}</div>`).join('')}
  </section>` : ''}

  ${activeProjects.length ? `<section class="card">
    <div class="card-head"><h3>🚀 プロジェクト</h3><a class="link-btn" href="#/projects">すべて</a></div>
    <div class="chips">${activeProjects.map(p => `<a class="chip" href="#/project/${p.id}">${esc(p.name)}</a>`).join('')}</div>
  </section>` : ''}

  <section class="card">
    <div class="card-head"><h3>🕘 最近のノート</h3><a class="link-btn" href="#/notes">すべて</a></div>
    ${recent.length ? recent.map(n => noteItem(n)).join('') : '<p class="muted">まだノートがありません。上の入力欄か、下の ＋ から書いてみましょう。</p>'}
  </section>`;

  let mood = null;
  $$('.mood', view).forEach(b => b.onclick = () => {
    mood = mood === +b.dataset.mood ? null : +b.dataset.mood;
    $$('.mood', view).forEach(x => { const on = +x.dataset.mood === mood; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
  });
  const text = $('#qc-text');
  if (matchMedia('(pointer:fine)').matches) text.focus();
  const save = async () => {
    const body = text.value.trim();
    if (!body && !mood) { text.focus(); return; }
    const projectId = $('#qc-project').value;
    settings.lastProject = projectId; saveSettings();
    await saveNote(newNote('memo', { body, mood, projectId }));
    toast('記録しました ✍️');
    renderHome();
  };
  $('#qc-save').onclick = save;
  text.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } };
  $('#next-prompt').onclick = () => {
    const el = $('#prompt-text'); const i = (+el.dataset.idx + 1 + Math.floor(Math.random() * (PROMPTS.length - 1))) % PROMPTS.length;
    el.dataset.idx = i; el.textContent = PROMPTS[i];
  };
  $('#answer-prompt').onclick = async () => {
    const q = PROMPTS[+$('#prompt-text').dataset.idx];
    const n = newNote('memo', { title: q, body: '' });
    await saveNote(n);
    location.hash = `#/note/${n.id}?new=1`;
  };
  $('#first-project')?.addEventListener('click', () => openProjectSheet());
}

// ---------- ノート一覧 ----------
const listState = { q: '', type: '', project: '', tag: '' };
function renderNotes() {
  setTitle('ノート'); setNav('notes');
  const tags = [...new Set(live().flatMap(allTags))].sort();
  view.innerHTML = `
  <div class="search-bar">
    <input id="q" type="search" placeholder="🔍 検索（タイトル・本文・タグ）" value="${esc(listState.q)}" autocomplete="off">
  </div>
  <div class="filters">
    <select id="f-type"><option value="">すべての種類</option>${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${listState.type === k ? 'selected' : ''}>${t.icon} ${t.label}</option>`).join('')}</select>
    <select id="f-project">${projectOptions(listState.project, 'すべてのプロジェクト')}</select>
    <select id="f-tag"><option value="">すべてのタグ</option>${tags.map(t => `<option value="${esc(t)}" ${listState.tag === t ? 'selected' : ''}>#${esc(t)}</option>`).join('')}</select>
  </div>
  <div id="results"></div>`;
  const draw = () => {
    const q = listState.q.trim().toLowerCase();
    const res = live().filter(n =>
      (!listState.type || n.type === listState.type) &&
      (!listState.project || n.projectId === listState.project) &&
      (!listState.tag || allTags(n).includes(listState.tag)) &&
      (!q || `${noteTitle(n)}\n${n.body}\n${allTags(n).join(' ')}`.toLowerCase().includes(q))
    ).sort((a, b) => b.createdAt - a.createdAt);
    let html = `<p class="muted small">${res.length}件</p>`, lastDay = '';
    for (const n of res) {
      const d = fmtDate(n.createdAt);
      if (d !== lastDay) { html += `<div class="day-sep">${d}</div>`; lastDay = d; }
      html += noteItem(n, listState.q.trim());
    }
    if (!res.length) html += '<p class="muted center">見つかりませんでした</p>';
    $('#results').innerHTML = html;
  };
  $('#q').oninput = e => { listState.q = e.target.value; draw(); };
  $('#f-type').onchange = e => { listState.type = e.target.value; draw(); };
  $('#f-project').onchange = e => { listState.project = e.target.value; draw(); };
  $('#f-tag').onchange = e => { listState.tag = e.target.value; draw(); };
  draw();
}

// ---------- エディタ ----------
let leaveEditor = null;
let flushEditor = null;
function findByTitle(title) {
  const t = title.trim().toLowerCase();
  return live().find(n => noteTitle(n).toLowerCase() === t);
}
async function openWikiLink(title) {
  const hit = findByTitle(title);
  if (hit) { location.hash = `#/note/${hit.id}`; return; }
  const n = newNote('memo', { title });
  await saveNote(n);
  toast(`「${title}」を新しく作りました`);
  location.hash = `#/note/${n.id}`;
}

function renderEditor(id, params) {
  const n = state.notes.find(x => x.id === id);
  if (!n) { view.innerHTML = '<p class="muted center">ノートが見つかりません</p>'; setTitle('ノート'); return; }
  setNav('notes');
  setTitle(TYPES[n.type]?.label || 'ノート');
  const template = TYPES[n.type]?.body || '';
  let mode = params.get('new') || !n.body || n.body === template ? 'edit' : 'preview';

  view.innerHTML = `
  <div class="editor ${n.deletedAt ? 'is-trash' : ''}">
    ${n.deletedAt ? `<div class="banner">このノートはゴミ箱にあります <button class="btn small" id="restore">元に戻す</button></div>` : ''}
    <input id="e-title" class="e-title" placeholder="${esc(noteTitle({ ...n, title: '' }))}" value="${esc(n.title)}" aria-label="タイトル">
    <div class="e-meta">
      <select id="e-type" aria-label="種類">${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${n.type === k ? 'selected' : ''}>${t.icon} ${t.label}</option>`).join('')}</select>
      <select id="e-project" aria-label="プロジェクト">${projectOptions(n.projectId)}</select>
      <span class="muted small">${fmtDate(n.createdAt)} ${fmtTime(n.createdAt)}</span>
    </div>
    <div class="mood-row compact">${MOODS.map(m => `<button class="mood ${n.mood === m.v ? 'on' : ''}" data-mood="${m.v}" title="${m.l}">${m.e}</button>`).join('')}</div>
    <input id="e-tags" class="e-tags" placeholder="タグ（スペース区切り） 例: UI バグ 設計" value="${esc((n.tags || []).join(' '))}" aria-label="タグ">
    <div class="e-toolbar">
      <div class="seg"><button data-mode="edit">編集</button><button data-mode="preview">表示</button></div>
      <div class="tools">
        <button data-ins="## " title="見出し">H</button>
        <button data-ins="- " title="リスト">•</button>
        <button data-ins="- [ ] " title="チェック">☑</button>
        <button data-wrap="**" title="太字"><b>B</b></button>
        <button data-wrap="[[|]]" title="ノートへのリンク">[[ ]]</button>
        <button id="focus" title="集中モード">⛶</button>
      </div>
    </div>
    <textarea id="e-body" class="e-body" placeholder="${esc(TYPES[n.type]?.hint || '')}">${esc(n.body)}</textarea>
    <div id="e-preview" class="e-preview md"></div>
    <div class="e-foot"><span id="save-state" class="muted small">保存済み</span>
      <span class="spacer"></span>
      ${n.deletedAt ? '<button class="btn danger small" id="purge">完全に削除</button>' : '<button class="btn ghost small" id="del">🗑 ゴミ箱へ</button>'}
    </div>
    <section id="backlinks"></section>
  </div>`;

  const body = $('#e-body'), preview = $('#e-preview'), titleEl = $('#e-title');
  const autoGrow = () => { body.style.height = 'auto'; body.style.height = Math.max(240, body.scrollHeight + 4) + 'px'; };
  const setMode = m => {
    mode = m;
    $$('.seg button', view).forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('.tools', view).style.visibility = m === 'edit' ? 'visible' : 'hidden';
    body.hidden = m !== 'edit'; preview.hidden = m === 'edit';
    if (m === 'preview') preview.innerHTML = render(n.body) || '<p class="muted">（空のノート）</p>';
    else { autoGrow(); }
  };
  let timer = null;
  const persist = async () => {
    clearTimeout(timer); timer = null;
    n.title = titleEl.value;
    n.body = body.value;
    n.tags = $('#e-tags').value.split(/[\s,、#]+/).map(s => s.trim()).filter(Boolean);
    await saveNote(n);
    $('#save-state').textContent = `保存済み ${fmtTime(n.updatedAt)}`;
  };
  const schedule = () => { $('#save-state').textContent = '編集中…'; clearTimeout(timer); timer = setTimeout(persist, 500); };

  titleEl.oninput = schedule;
  body.oninput = () => { autoGrow(); schedule(); };
  $('#e-tags').oninput = schedule;
  $('#e-type').onchange = async e => {
    const old = n.type; n.type = e.target.value;
    if (body.value.trim() === '' || body.value === TYPES[old]?.body) { body.value = TYPES[n.type].body; autoGrow(); }
    setTitle(TYPES[n.type].label); await persist();
  };
  $('#e-project').onchange = async e => { n.projectId = e.target.value; settings.lastProject = n.projectId; saveSettings(); await persist(); };
  $$('.mood', view).forEach(b => b.onclick = async () => {
    n.mood = n.mood === +b.dataset.mood ? null : +b.dataset.mood;
    $$('.mood', view).forEach(x => x.classList.toggle('on', +x.dataset.mood === n.mood));
    await persist();
  });
  $$('.seg button', view).forEach(b => b.onclick = async () => { if (timer) await persist(); setMode(b.dataset.mode); });
  $$('[data-ins]', view).forEach(b => b.onclick = () => {
    const s = body.selectionStart, ls = body.value.lastIndexOf('\n', s - 1) + 1;
    body.setRangeText(b.dataset.ins, ls, ls, 'end'); body.focus(); schedule();
  });
  $$('[data-wrap]', view).forEach(b => b.onclick = () => {
    const [l, r = l] = b.dataset.wrap.split('|');
    const s = body.selectionStart, e = body.selectionEnd, sel = body.value.slice(s, e);
    body.setRangeText(l + sel + r, s, e, 'select');
    if (!sel) body.setSelectionRange(s + l.length, s + l.length);
    body.focus(); schedule();
  });
  $('#focus').onclick = () => document.body.classList.toggle('focus');
  preview.onclick = async e => {
    const a = e.target.closest('.wikilink');
    if (a) { e.preventDefault(); await persist(); openWikiLink(a.dataset.title); return; }
    const cb = e.target.closest('input[type=checkbox][data-line]');
    if (cb) {
      const lines = n.body.split('\n'); const i = +cb.dataset.line;
      lines[i] = lines[i].replace(/\[( |x|X)\]/, cb.checked ? '[x]' : '[ ]');
      body.value = n.body = lines.join('\n'); await persist(); setMode('preview');
    }
  };
  $('#del')?.addEventListener('click', async () => {
    n.deletedAt = Date.now(); await persist(); toast('ゴミ箱に移しました（設定から戻せます）'); location.hash = '#/notes';
  });
  $('#restore')?.addEventListener('click', async () => { n.deletedAt = null; await persist(); renderEditor(id, params); toast('元に戻しました'); });
  $('#purge')?.addEventListener('click', async () => {
    if (!confirm('完全に削除します。元に戻せません。よろしいですか？')) return;
    await db.del('notes', n.id); state.notes = state.notes.filter(x => x.id !== n.id); location.hash = '#/settings';
  });

  // バックリンク
  const myTitle = noteTitle(n).toLowerCase();
  const back = live().filter(x => x.id !== n.id && wikiLinks(x.body).some(t => t.toLowerCase() === myTitle));
  $('#backlinks').innerHTML = back.length ? `<h4>🔗 このノートを参照しているノート</h4>${back.map(x => noteItem(x)).join('')}` : '';

  setMode(mode);
  if (params.get('new')) {
    if (n.title) { body.focus(); const p = body.value.indexOf('- ') + 2; if (p > 1) body.setSelectionRange(p, p); }
    else titleEl.focus();
  }

  // 画面を離れるとき：未保存の変更を保存し、作っただけで何も書いていない新規ノートは破棄
  const initial = { title: n.title, body: n.body };
  const isNew = !!params.get('new');
  flushEditor = () => timer && persist();
  leaveEditor = async () => {
    flushEditor = null;
    document.body.classList.remove('focus');
    if (timer) await persist();
    if (isNew && !n.deletedAt && n.title === initial.title && n.body === initial.body && !n.mood && !(n.tags || []).length) {
      await db.del('notes', n.id); state.notes = state.notes.filter(x => x.id !== n.id);
    }
  };
}

// ---------- プロジェクト ----------
function openProjectSheet(p = null) {
  sheet(`<h3>${p ? 'プロジェクトを編集' : '新しいプロジェクト'}</h3>
    <label class="field"><span>アプリ名</span><input id="p-name" value="${esc(p?.name || '')}" placeholder="例: 家計簿アプリ"></label>
    <label class="field"><span>目的（なぜ作る？誰のため？）</span><textarea id="p-purpose" rows="4" placeholder="例: 自分の支出を3秒で記録できるようにしたい。既存アプリは入力が面倒で続かなかったから。">${esc(p?.purpose || '')}</textarea></label>
    <div class="row"><button class="btn ghost" data-close>キャンセル</button><button class="btn primary" id="p-save">保存</button></div>`, (root, close) => {
    $('#p-name', root).focus();
    $('#p-save', root).onclick = async () => {
      const name = $('#p-name', root).value.trim();
      if (!name) { $('#p-name', root).focus(); return; }
      const proj = p || { id: uid(), schema: 1, createdAt: Date.now(), archived: false };
      proj.name = name; proj.purpose = $('#p-purpose', root).value.trim();
      await saveProject(proj);
      if (!p) { settings.lastProject = proj.id; saveSettings(); }
      close();
      location.hash = `#/project/${proj.id}`;
      route();
    };
  });
}

function renderProjects() {
  setTitle('プロジェクト'); setNav('projects');
  const notes = live();
  const card = p => {
    const ns = notes.filter(n => n.projectId === p.id);
    const last = ns.reduce((m, n) => Math.max(m, n.createdAt), 0);
    return `<a class="card project-card ${p.archived ? 'archived' : ''}" href="#/project/${p.id}">
      <h3>${esc(p.name)}${p.archived ? ' <span class="badge">完了/保管</span>' : ''}</h3>
      <p class="muted">${p.purpose ? esc(p.purpose.slice(0, 90)) : '（目的が未記入）'}</p>
      <p class="small muted">ノート ${ns.length}件${last ? ` · 最終記録 ${fmtDate(last)}` : ''}</p>
    </a>`;
  };
  const active = state.projects.filter(p => !p.archived), archived = state.projects.filter(p => p.archived);
  view.innerHTML = `
    <button class="btn primary block" id="new-project">＋ 新しいプロジェクト</button>
    ${active.map(card).join('') || '<p class="muted center">作っているアプリを登録しましょう</p>'}
    ${archived.length ? `<h4 class="muted">完了・保管</h4>${archived.map(card).join('')}` : ''}`;
  $('#new-project').onclick = () => openProjectSheet();
}

function renderProject(id) {
  const p = projectOf(id);
  if (!p) { location.hash = '#/projects'; return; }
  setTitle(p.name); setNav('projects');
  const ns = live().filter(n => n.projectId === id).sort((a, b) => a.createdAt - b.createdAt);
  const first = ns[0]?.createdAt || p.createdAt;
  const elapsed = Math.max(1, Math.round((Date.now() - first) / 864e5));
  const moods = ns.filter(n => n.mood).map(n => n.mood);
  const counts = Object.keys(TYPES).map(k => [k, ns.filter(n => n.type === k).length]).filter(([, c]) => c);

  let tl = '', lastMonth = '';
  for (const n of [...ns].reverse()) {
    const d = new Date(n.createdAt), m = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    if (m !== lastMonth) { tl += `<div class="tl-month">${m}</div>`; lastMonth = m; }
    tl += `<a class="tl-item t-${n.type}" href="#/note/${n.id}">
      <span class="tl-dot">${TYPES[n.type]?.icon}</span>
      <span class="tl-body"><span class="tl-date">${fmtShort(n.createdAt)} ${n.mood ? moodEmoji(n.mood) : ''}</span>
      <span class="tl-title">${esc(noteTitle(n))}</span>
      ${n.type === 'decision' || n.type === 'purpose' ? `<span class="ni-snip">${esc(snippet(n, 100))}</span>` : ''}</span></a>`;
  }

  view.innerHTML = `
  <section class="card purpose-card">
    <div class="card-head"><h3>🎯 目的</h3><button class="link-btn" id="edit-project">編集</button></div>
    <p class="purpose">${p.purpose ? esc(p.purpose).replace(/\n/g, '<br>') : '<span class="muted">まだ書かれていません。「なぜ作るのか」を書いておくと、迷ったときの道しるべになります。</span>'}</p>
  </section>
  <section class="stats">
    <div><b>${elapsed}</b><small>日目</small></div>
    <div><b>${ns.length}</b><small>ノート</small></div>
    <div><b>${moods.length ? (moods.reduce((a, b) => a + b, 0) / moods.length).toFixed(1) : '-'}</b><small>平均気分</small></div>
  </section>
  ${counts.length ? `<div class="chips">${counts.map(([k, c]) => `<span class="chip">${TYPES[k].icon} ${TYPES[k].label} ${c}</span>`).join('')}</div>` : ''}
  <div class="row wrap">
    <button class="btn primary" id="p-new">＋ このプロジェクトに書く</button>
    <button class="btn ghost" id="p-archive">${p.archived ? '進行中に戻す' : '完了・保管にする'}</button>
  </div>
  <section class="card">
    <h3>🧭 経緯（タイムライン）</h3>
    <div class="timeline">${tl || '<p class="muted">まだ記録がありません。最初の「目的・動機」ノートを書いてみましょう。</p>'}</div>
  </section>`;
  $('#edit-project').onclick = () => openProjectSheet(p);
  $('#p-new').onclick = () => openNewNoteSheet({ projectId: id });
  $('#p-archive').onclick = async () => { p.archived = !p.archived; await saveProject(p); renderProject(id); };
}

// ---------- 気付き ----------
function moodChart(series) {
  const W = 320, H = 120, P = 18;
  const pts = series.map((s, i) => s.avg == null ? null : [P + i * (W - 2 * P) / (series.length - 1), H - P - (s.avg - 1) * (H - 2 * P) / 4]);
  let path = '', pen = false;
  pts.forEach(p => { if (!p) { pen = false; return; } path += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)} `; pen = true; });
  const dots = pts.map((p, i) => p ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3"><title>${series[i].day}: ${series[i].avg.toFixed(1)}</title></circle>` : '').join('');
  const grid = [1, 3, 5].map(v => { const y = H - P - (v - 1) * (H - 2 * P) / 4; return `<line x1="${P}" x2="${W - P}" y1="${y}" y2="${y}"/><text x="2" y="${y + 4}">${moodEmoji(v)}</text>`; }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="直近30日の気分の推移"><g class="grid">${grid}</g><path d="${path}"/>${dots}</svg>
    <div class="chart-x muted small"><span>${series[0].day.slice(5)}</span><span>今日</span></div>`;
}

function renderInsights() {
  setTitle('気付き'); setNav('insights');
  const notes = live();
  const series = ins.moodSeries(notes, 30);
  const hasMood = series.some(s => s.avg != null);
  const tm = ins.tagMood(notes);
  const words = ins.topWords(notes.filter(n => n.createdAt > Date.now() - 30 * 864e5));
  const tasks = ins.openTasks(notes);
  const weekAgo = Date.now() - 7 * 864e5;
  const week = notes.filter(n => n.createdAt > weekAgo);
  const prevWeek = notes.filter(n => n.createdAt <= weekAgo && n.createdAt > weekAgo - 7 * 864e5);
  const avg = a => { const m = a.filter(n => n.mood).map(n => n.mood); return m.length ? m.reduce((x, y) => x + y, 0) / m.length : null; };
  const wAvg = avg(week), pAvg = avg(prevWeek);
  const bestNote = [...week].filter(n => n.mood).sort((a, b) => b.mood - a.mood)[0];
  const worstNote = [...week].filter(n => n.mood).sort((a, b) => a.mood - b.mood)[0];

  view.innerHTML = `
  <section class="card">
    <h3>📅 この1週間</h3>
    <div class="stats inner">
      <div><b>${week.length}</b><small>ノート</small></div>
      <div><b>${new Set(week.map(n => ins.dayKey(n.createdAt))).size}</b><small>記録した日</small></div>
      <div><b>${wAvg ? wAvg.toFixed(1) : '-'}</b><small>平均気分${wAvg && pAvg ? ` <span class="${wAvg >= pAvg ? 'up' : 'down'}">${wAvg >= pAvg ? '▲' : '▼'}${Math.abs(wAvg - pAvg).toFixed(1)}</span>` : ''}</small></div>
    </div>
    ${bestNote && worstNote && bestNote !== worstNote && bestNote.mood > worstNote.mood ? `
      <p class="small">いちばん良かった時 ${moodEmoji(bestNote.mood)}</p>${noteItem(bestNote)}
      <p class="small">いちばんしんどかった時 ${moodEmoji(worstNote.mood)}</p>${noteItem(worstNote)}
      <p class="muted small">→ 2つの違いは何だろう？</p>` : ''}
    <button class="btn" id="write-weekly">🔁 週次ふりかえりを書く</button>
  </section>

  <section class="card">
    <h3>📈 気分の推移（30日）</h3>
    ${hasMood ? moodChart(series) : '<p class="muted">ノートに気分を付けるとここにグラフが出ます。</p>'}
  </section>

  <section class="card">
    <h3>🏷 タグと気分</h3>
    ${tm.length ? `<p class="muted small">タグごとの気分の平均（全体平均との差）。※相関であって因果ではありません</p>
      <div class="bars">${tm.slice(0, 10).map(t => `<div class="bar-row"><span class="bar-label">#${esc(t.tag)} <small class="muted">${t.count}</small></span><span class="bar-track"><span class="bar ${t.diff >= 0 ? 'pos' : 'neg'}" style="width:${Math.min(100, Math.abs(t.diff) * 50)}%"></span></span><span class="bar-val">${t.diff >= 0 ? '+' : ''}${t.diff.toFixed(1)}</span></div>`).join('')}</div>`
      : '<p class="muted">タグと気分を付けたノートが増えると、「どんな作業の時に気分が良い/悪いか」が見えてきます。</p>'}
  </section>

  <section class="card">
    <h3>💬 最近よく出る言葉（30日）</h3>
    ${words.length ? `<div class="chips">${words.map(([w, c]) => `<button class="chip word" data-w="${esc(w)}" style="font-size:${Math.min(1.4, 0.85 + c * 0.06)}rem">${esc(w)} <small>${c}</small></button>`).join('')}</div>
      <p class="muted small">タップすると、その言葉を含むノートを検索します。</p>` : '<p class="muted">ノートが増えると、頭の中を占めている言葉が見えてきます。</p>'}
  </section>

  <section class="card">
    <h3>✅ まだやっていない「次にやること」</h3>
    ${tasks.length ? `<p class="muted small">${tasks.length}件 · 放置されているものは、本当に必要？</p>
      <ul class="task-list">${tasks.slice(0, 30).map((t, i) => `<li><label><input type="checkbox" data-i="${i}"> <span>${esc(t.text)}</span></label><a class="muted small" href="#/note/${t.note.id}">${fmtDate(t.note.createdAt)} · ${esc(noteTitle(t.note).slice(0, 20))}</a></li>`).join('')}</ul>`
      : '<p class="muted">開発ログの「- [ ] 」がここに集まります。</p>'}
  </section>`;

  $('#write-weekly').onclick = async () => { const n = newNote('weekly'); await saveNote(n); location.hash = `#/note/${n.id}?new=1`; };
  $$('.word', view).forEach(b => b.onclick = () => { Object.assign(listState, { q: b.dataset.w, type: '', project: '', tag: '' }); location.hash = '#/notes'; });
  $$('.task-list input', view).forEach(cb => cb.onchange = async () => {
    const t = tasks[+cb.dataset.i];
    const lines = t.note.body.split('\n');
    lines[t.line] = lines[t.line].replace('[ ]', '[x]');
    t.note.body = lines.join('\n');
    await saveNote(t.note);
    cb.closest('li').classList.add('done');
    toast('完了にしました 🎉');
  });
}

// ---------- 設定 ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function toMarkdown() {
  const out = [`# 開発ノート エクスポート (${fmtDate(Date.now())})\n`];
  for (const p of state.projects) out.push(`\n# 🚀 ${p.name}\n\n> ${(p.purpose || '').replace(/\n/g, '\n> ')}\n`);
  const sorted = live().sort((a, b) => a.createdAt - b.createdAt);
  for (const n of sorted) {
    const p = projectOf(n.projectId);
    out.push(`\n---\n\n## ${TYPES[n.type]?.icon || ''} ${noteTitle(n)}\n\n- 日時: ${fmtDate(n.createdAt)} ${fmtTime(n.createdAt)}\n- 種類: ${TYPES[n.type]?.label || n.type}${p ? `\n- プロジェクト: ${p.name}` : ''}${n.mood ? `\n- 気分: ${moodEmoji(n.mood)} ${MOODS[n.mood - 1].l}` : ''}${(n.tags || []).length ? `\n- タグ: ${n.tags.map(t => '#' + t).join(' ')}` : ''}\n\n${(n.body || '').replace(/^(#{1,4})\s/gm, '$1## ')}\n`);
  }
  return out.join('');
}

async function renderSettings() {
  setTitle('設定'); setNav('');
  const trash = state.notes.filter(n => n.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  let persisted = false; try { persisted = await navigator.storage?.persisted?.(); } catch {}
  let usage = ''; try { const e = await navigator.storage?.estimate?.(); if (e) usage = `${(e.usage / 1024).toFixed(0)} KB 使用中`; } catch {}

  view.innerHTML = `
  <section class="card">
    <h3>🎨 表示</h3>
    <div class="seg wide" id="theme">${[['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']].map(([v, l]) => `<button data-v="${v}" class="${settings.theme === v ? 'on' : ''}">${l}</button>`).join('')}</div>
  </section>
  <section class="card">
    <h3>🌿 週の目標</h3>
    <p class="muted small">「毎日」ではなく「週に◯日」。途切れても責めない仕組みです。</p>
    <div class="seg wide" id="goal">${[1, 2, 3, 4, 5, 6, 7].map(v => `<button data-v="${v}" class="${settings.weekGoal === v ? 'on' : ''}">${v}日</button>`).join('')}</div>
  </section>
  <section class="card">
    <h3>💾 データ</h3>
    <p class="muted small">データはこの端末のブラウザ内だけに保存されています（${usage}${persisted ? '・保護済み' : ''}）。<b>ときどきバックアップを書き出してください。</b>特にiPhoneでは、ブラウザがデータを消すことがあります。</p>
    <div class="row wrap">
      <button class="btn primary" id="exp-json">バックアップ (JSON)</button>
      <button class="btn" id="exp-md">Markdownで書き出し</button>
      <label class="btn">復元 (JSON)<input type="file" id="imp" accept="application/json,.json" hidden></label>
    </div>
    ${!persisted ? '<button class="link-btn" id="persist">ブラウザにデータの保護をお願いする</button>' : ''}
  </section>
  <section class="card">
    <h3>🗑 ゴミ箱 (${trash.length})</h3>
    ${trash.length ? trash.map(n => noteItem(n)).join('') + '<button class="btn danger small" id="empty-trash">ゴミ箱を空にする</button>' : '<p class="muted">空です</p>'}
  </section>
  <section class="card">
    <h3>ℹ️ このアプリについて</h3>
    <p class="small">作っているアプリの「経緯・目的・感想」を記録して、振り返りから気付きを得るためのノートです。無料・広告なし・データは自分の端末だけ。</p>
    <p class="small muted">ヒント: 本文に <code>[[ノート名]]</code> と書くとノート同士をリンクでき、リンク先にはバックリンクが表示されます。<code>#タグ</code> も使えます。</p>
    <button class="link-btn danger" id="wipe">すべてのデータを削除</button>
  </section>`;

  $$('#theme button').forEach(b => b.onclick = () => { settings.theme = b.dataset.v; saveSettings(); applyTheme(); renderSettings(); });
  $$('#goal button').forEach(b => b.onclick = () => { settings.weekGoal = +b.dataset.v; saveSettings(); renderSettings(); });
  const stamp = new Date().toISOString().slice(0, 10);
  $('#exp-json').onclick = () => { download(`devnote-backup-${stamp}.json`, JSON.stringify({ app: 'devnote', version: 1, exportedAt: Date.now(), projects: state.projects, notes: state.notes }, null, 2), 'application/json'); settings.lastBackup = Date.now(); saveSettings(); };
  $('#exp-md').onclick = () => download(`devnote-${stamp}.md`, toMarkdown(), 'text/markdown');
  $('#imp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'devnote' || !Array.isArray(data.notes)) throw new Error('形式が違います');
      // id が同じものは更新日時が新しい方を残す（マージ）
      const merge = (cur, inc) => { const m = new Map(cur.map(x => [x.id, x])); let c = 0; for (const x of inc) { const o = m.get(x.id); if (!o || (x.updatedAt || 0) > (o.updatedAt || 0)) { m.set(x.id, x); c++; } } return [[...m.values()], c]; };
      const [ps, pc] = merge(state.projects, data.projects || []);
      const [ns, nc] = merge(state.notes, data.notes);
      await db.bulkPut('projects', ps); await db.bulkPut('notes', ns);
      state.projects = ps; state.notes = ns;
      toast(`復元しました（ノート${nc}件・プロジェクト${pc}件を更新）`);
      renderSettings();
    } catch (err) { alert('読み込めませんでした: ' + err.message); }
  };
  $('#persist')?.addEventListener('click', async () => { const ok = await requestPersist(); toast(ok ? '保護されました' : 'このブラウザでは保護できませんでした。バックアップを使ってください'); renderSettings(); });
  $('#empty-trash')?.addEventListener('click', async () => {
    if (!confirm(`ゴミ箱の${trash.length}件を完全に削除します。よろしいですか？`)) return;
    for (const n of trash) await db.del('notes', n.id);
    state.notes = state.notes.filter(n => !n.deletedAt); renderSettings();
  });
  $('#wipe').onclick = async () => {
    if (!confirm('すべてのノートとプロジェクトを削除します。先にバックアップを取りましたか？')) return;
    if (prompt('確認のため「削除」と入力してください') !== '削除') return;
    await db.clear('notes'); await db.clear('projects'); state.notes = []; state.projects = []; toast('削除しました'); location.hash = '#/home';
  };
}

// ---------- テーマ ----------
function applyTheme() {
  const t = settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

// ---------- ルーティング ----------
async function route() {
  if (leaveEditor) { const f = leaveEditor; leaveEditor = null; await f(); }
  const [path, qs] = (location.hash.slice(1) || '/home').split('?');
  const params = new URLSearchParams(qs || '');
  const [, name, id] = path.split('/');
  document.body.dataset.view = name || 'home';
  window.scrollTo(0, 0);
  switch (name) {
    case 'notes': renderNotes(); break;
    case 'note': renderEditor(id, params); break;
    case 'projects': renderProjects(); break;
    case 'project': renderProject(id); break;
    case 'insights': renderInsights(); break;
    case 'settings': await renderSettings(); break;
    default: renderHome();
  }
}

async function init() {
  applyTheme();
  [state.notes, state.projects] = await Promise.all([db.all('notes'), db.all('projects')]);
  state.projects.sort((a, b) => a.createdAt - b.createdAt);
  window.addEventListener('hashchange', route);
  $('#fab').onclick = () => openNewNoteSheet(location.hash.startsWith('#/project/') ? { projectId: location.hash.split('/')[2] } : {});
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (!$('#sheet').hidden) { $('#sheet').hidden = true; $('#sheet').innerHTML = ''; } else document.body.classList.remove('focus'); }
  });
  window.addEventListener('pagehide', () => flushEditor?.());
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushEditor?.(); }); // アプリを閉じる前に入力途中の内容を保存
  route();
  if (state.notes.length > 5) requestPersist();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
}
init();
