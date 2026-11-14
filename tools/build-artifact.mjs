// claude.ai のアーティファクト用に、アプリを1つの HTML ファイルにまとめる
//   node tools/build-artifact.mjs  →  dist/devnote-artifact.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const strip = src => src.replace(/^import .*$/gm, '').replace(/^export (?=(const|let|function|async function|class) )/gm, '');

// insights.js は `ins.xxx` で使うので名前空間オブジェクトにする
const insSrc = strip(read('js/insights.js'));
const insNames = [...read('js/insights.js').matchAll(/^export (?:const|function) (\w+)/gm)].map(m => m[1]);
const insights = `const ins = (() => {\n${insSrc}\nreturn { ${insNames.join(', ')} };\n})();`;

const js = [strip(read('js/db.js')), strip(read('js/templates.js')), strip(read('js/markdown.js')), insights, strip(read('js/app.js'))].join('\n\n');
const html = read('index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script type="module" src="js\/app.js"><\/script>/, '')
  .replace(/<noscript>.*<\/noscript>/, '');

const out = `<title>開発ノート</title>
<style>
${read('style.css')}
</style>
${body.trim()}
<script type="module">
${js}
</script>
`;
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/devnote-artifact.html'), out);
console.log('dist/devnote-artifact.html', (out.length / 1024).toFixed(1) + ' KB');
