/**
 * .gs 파일을 붙여넣기 좋게 묶는다.
 *
 * 아이폰 Apps Script 편집기에서는 긴 코드를 전체 선택해 지우는 게 고통스럽다.
 * 그래서 앞으로 자주 고칠 파서만 따로 떼어, 갈아끼울 분량을 줄인다.
 *
 *   budget-parser.gs   문자 파서. 실제 문자 포맷을 알아갈수록 자주 바뀐다
 *   budget-core.gs     나머지 전부. 거의 안 바뀐다
 *
 * 최상위 const는 함수 안에서만 참조하므로 두 파일의 순서는 상관없다.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGETS = {
  'budget-parser.gs': ['Parse.gs'],
  'budget-core.gs': [
    'Config.gs', 'Util.gs', 'Schema.gs', 'Seed.gs',
    'Classify.gs', 'Settlement.gs', 'Ingest.gs', 'Code.gs', 'Debug.gs',
  ],
};

const src = path.join(__dirname, 'apps-script');
const out = path.join(__dirname, 'dist');
fs.mkdirSync(out, { recursive: true });

// 예전 단일 번들이 남아 있으면 어느 것을 붙여야 하는지 헷갈린다
const stale = path.join(out, 'bundle.gs');
if (fs.existsSync(stale)) fs.unlinkSync(stale);

Object.keys(TARGETS).forEach((target) => {
  const banner = [
    '/**',
    ' * 이 파일은 build.js가 생성합니다. 직접 고치지 마세요.',
    ' * 원본: ' + TARGETS[target].map((f) => 'apps-script/' + f).join(', '),
    ' *',
    ' * 사용법: 전체를 복사해 Apps Script의 같은 이름 파일에 붙여넣으세요.',
    ' */',
    '',
  ].join('\n');

  const body = TARGETS[target].map((file) => {
    const code = fs.readFileSync(path.join(src, file), 'utf8').trim();
    return '// ===== ' + file + ' ' + '='.repeat(Math.max(1, 58 - file.length)) + '\n\n' + code;
  }).join('\n\n');

  const content = banner + body + '\n';
  fs.writeFileSync(path.join(out, target), content);

  // 깨진 코드를 붙여넣게 되는 일이 없도록 문법을 확인한다.
  // node --check는 .gs 확장자를 모르므로 .js로 한 벌 떠서 검사한다.
  const probe = path.join(out, '.check.js');
  fs.writeFileSync(probe, content);
  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
  } catch (err) {
    fs.unlinkSync(probe);
    console.error(target + ' 문법 오류:\n' + err.stderr.toString());
    process.exit(1);
  }
  fs.unlinkSync(probe);

  console.log(target.padEnd(20) + String(content.split('\n').length).padStart(5) + '줄  문법 OK');
});
