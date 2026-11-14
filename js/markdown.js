// 最小限の Markdown レンダラー（HTMLはすべてエスケープしてから変換）
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, t) => `<a href="#" class="wikilink" data-title="${t}">${t}</a>`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|\s)#([^\s#.,、。!?！？]+)/g, '$1<span class="tag">#$2</span>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  return s;
}

export function render(md) {
  const lines = String(md ?? '').split('\n');
  let html = '';
  let list = null; // 'ul' | 'ol'
  let inCode = false, code = [];
  const close = () => { if (list) { html += `</${list}>`; list = null; } };

  lines.forEach((line, idx) => {
    if (/^```/.test(line)) {
      if (inCode) { html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; code = []; inCode = false; }
      else { close(); inCode = true; }
      return;
    }
    if (inCode) { code.push(line); return; }

    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { close(); const n = m[1].length + 1; html += `<h${n}>${inline(m[2])}</h${n}>`; return; }
    if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s?(.*)$/))) {
      if (list !== 'ul') { close(); html += '<ul class="tasks">'; list = 'ul'; }
      const done = m[1] !== ' ';
      html += `<li class="task${done ? ' done' : ''}"><input type="checkbox" data-line="${idx}" ${done ? 'checked' : ''}> <span>${inline(m[2])}</span></li>`;
      return;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; return; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; return; }
    if ((m = line.match(/^>\s?(.*)$/))) { close(); html += `<blockquote>${inline(m[1])}</blockquote>`; return; }
    if (/^---+$/.test(line.trim())) { close(); html += '<hr>'; return; }
    if (!line.trim()) { close(); return; }
    close();
    html += `<p>${inline(line)}</p>`;
  });
  if (inCode) html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
  close();
  return html;
}

// [[リンク]] の抽出
export const wikiLinks = md => [...String(md ?? '').matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1].trim());

// 本文中の #タグ の抽出
export const inlineTags = md => [...String(md ?? '').matchAll(/(?:^|\s)#([^\s#.,、。!?！？]+)/g)].map(m => m[1]);
