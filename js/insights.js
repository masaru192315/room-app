// 気付き（インサイト）の集計ロジック
export const dayKey = d => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export function countByDay(notes) {
  const map = new Map();
  for (const n of notes) { const k = dayKey(n.createdAt); map.set(k, (map.get(k) || 0) + 1); }
  return map;
}

// 週の始まり（月曜）
export function weekStart(d = new Date()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

// 今週記録した日数
export function daysThisWeek(notes) {
  const start = weekStart().getTime();
  return new Set(notes.filter(n => n.createdAt >= start).map(n => dayKey(n.createdAt))).size;
}

// 週目標を達成した週が何週続いているか（今週は達成済みなら含める）
export function weekStreak(notes, goal) {
  const byWeek = new Map();
  for (const n of notes) {
    const w = weekStart(n.createdAt).getTime();
    if (!byWeek.has(w)) byWeek.set(w, new Set());
    byWeek.get(w).add(dayKey(n.createdAt));
  }
  let streak = 0;
  const cur = weekStart();
  if ((byWeek.get(cur.getTime())?.size || 0) >= goal) streak++;
  const w = new Date(cur);
  for (;;) {
    w.setDate(w.getDate() - 7);
    if ((byWeek.get(w.getTime())?.size || 0) >= goal) streak++; else break;
  }
  return streak;
}

// 過去の今日（1週間前・1か月前・半年前・1年前…）
export function onThisDay(notes, now = new Date()) {
  const targets = [
    { label: '1週間前', d: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7) },
    { label: '1か月前', d: new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()) },
    { label: '3か月前', d: new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()) },
    { label: '半年前', d: new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()) },
  ];
  for (let y = 1; y <= 5; y++) targets.push({ label: `${y}年前`, d: new Date(now.getFullYear() - y, now.getMonth(), now.getDate()) });
  const out = [];
  for (const t of targets) {
    const k = dayKey(t.d);
    const hit = notes.filter(n => dayKey(n.createdAt) === k);
    if (hit.length) out.push({ label: t.label, notes: hit });
  }
  return out;
}

// 日ごとの気分の平均（直近 days 日）
export function moodSeries(notes, days = 30) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const k = dayKey(d);
    const ms = notes.filter(n => n.mood && dayKey(n.createdAt) === k).map(n => n.mood);
    series.push({ day: k, avg: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null });
  }
  return series;
}

// タグ別の気分平均（2件以上あるタグのみ）
export function tagMood(notes) {
  const withMood = notes.filter(n => n.mood);
  if (withMood.length < 3) return [];
  const overall = withMood.reduce((a, n) => a + n.mood, 0) / withMood.length;
  const map = new Map();
  for (const n of withMood) for (const t of n.tags || []) {
    if (!map.has(t)) map.set(t, []);
    map.get(t).push(n.mood);
  }
  return [...map].filter(([, v]) => v.length >= 2)
    .map(([tag, v]) => { const avg = v.reduce((a, b) => a + b, 0) / v.length; return { tag, count: v.length, avg, diff: avg - overall }; })
    .sort((a, b) => b.diff - a.diff);
}

// よく出る言葉（Intl.Segmenter で日本語を単語に分割）
const STOP = new Set(['こと', 'もの', 'ため', 'よう', 'これ', 'それ', 'あれ', 'ここ', 'そこ', 'とき', 'ところ', 'やったこと', 'わかったこと', '次にやること', 'ハマったこと', '感じ', 'さん', 'して', 'する', 'した', 'ある', 'いる', 'なる', 'できる', '思う', '今日', '自分', 'Liked', 'Learned', 'Lacked', 'Longed', 'for', 'Try', 'Stop', 'the', 'and']);
export function topWords(notes, limit = 20) {
  const freq = new Map();
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
  for (const n of notes) {
    const text = `${n.title || ''}\n${n.body || ''}`.replace(/^#+.*$/gm, '').replace(/\[[ xX]\]/g, '');
    const words = seg ? [...seg.segment(text)].filter(s => s.isWordLike).map(s => s.segment) : text.split(/[\s、。,.!?！？「」()（）]+/);
    for (const w of words) {
      if (w.length < 2 || STOP.has(w) || /^[぀-ゟ]+$/.test(w) || /^\d+$/.test(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// 未完了の「次にやること / Try」（チェックボックス）を集める
export function openTasks(notes) {
  const out = [];
  for (const n of notes) {
    const lines = (n.body || '').split('\n');
    lines.forEach((line, idx) => {
      const m = line.match(/^\s*[-*]\s+\[ \]\s?(.*)$/);
      if (m && m[1].trim()) out.push({ note: n, line: idx, text: m[1].trim() });
    });
  }
  return out.sort((a, b) => b.note.createdAt - a.note.createdAt);
}
