/**
 * .gs 파일을 하나로 합친다.
 *
 * 아이폰에서 Apps Script 편집기에 파일을 여러 개 만드는 건 고통스럽다.
 * dist/bundle.gs 하나만 복사해 붙이면 되도록 묶는다.
 */
const fs = require('fs');
const path = require('path');

// CONFIG/SCHEMA 같은 최상위 const가 먼저 오도록 순서를 고정한다
const ORDER = [
  'Config.gs', 'Util.gs', 'Schema.gs', 'Seed.gs',
  'Parse.gs', 'Classify.gs', 'Settlement.gs', 'Ingest.gs', 'Code.gs',
];

const src = path.join(__dirname, 'apps-script');
const out = path.join(__dirname, 'dist');
fs.mkdirSync(out, { recursive: true });

const banner = [
  '/**',
  ' * 이 파일은 build.js가 생성합니다. 직접 고치지 마세요.',
  ' * 원본: apps-script/*.gs',
  ' *',
  ' * 사용법: 전체를 복사해 Apps Script 편집기의 Code.gs에 붙여넣으세요.',
  ' */',
  '',
].join('\n');

const body = ORDER.map((file) => {
  const code = fs.readFileSync(path.join(src, file), 'utf8').trim();
  return '// ===== ' + file + ' '.repeat(Math.max(1, 60 - file.length)) + '=====\n\n' + code;
}).join('\n\n');

const bundle = banner + body + '\n';
fs.writeFileSync(path.join(out, 'bundle.gs'), bundle);

// 붙여넣기 직전에 깨진 번들을 내보내지 않도록 문법을 확인한다.
// node --check는 .gs 확장자를 모르므로 .js로 한 벌 떠서 검사한다.
const probe = path.join(out, '.bundle.check.js');
fs.writeFileSync(probe, bundle);
try {
  require('child_process').execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
} catch (err) {
  fs.unlinkSync(probe);
  console.error('번들 문법 오류:\n' + err.stderr.toString());
  process.exit(1);
}
fs.unlinkSync(probe);

const lines = bundle.split('\n').length;
console.log('dist/bundle.gs  ' + lines + '줄  ' + (bundle.length / 1024).toFixed(1) + 'KB  문법 OK');
