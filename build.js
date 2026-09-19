/**
 * .gs 파일을 붙여넣기 좋게 묶는다. 두 가지 모양으로 낸다.
 *
 *   bundle.gs          전부 한 파일. PC에서는 Code.gs 하나를 통째로 바꾸면 끝이라 이쪽이 쉽다
 *   budget-parser.gs   문자 파서만. 실제 문자 포맷을 알아갈수록 자주 바뀐다
 *   budget-core.gs     파서를 뺀 나머지
 *
 * 쪼갠 쪽은 아이폰용이다. 아이폰 편집기에서는 긴 코드를 전체 선택해 지우는 게
 * 고통스러워서, 자주 고치는 파서만 갈아끼울 수 있게 떼어 둔다.
 *
 * 둘 중 하나만 쓴다. 셋을 다 넣으면 같은 함수가 두 벌이 되어 엉뚱하게 돈다.
 *
 * 최상위 const는 함수 안에서만 참조하므로 파일 순서는 상관없다.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = [
  'Config.gs', 'Util.gs', 'Schema.gs', 'Seed.gs',
  'Classify.gs', 'Menu.gs', 'Settlement.gs', 'Ingest.gs',
  'Ledger.gs', 'DashboardHtml.gs', 'Web.gs', 'Code.gs', 'Debug.gs',
];

const TARGETS = {
  'bundle.gs': CORE.slice(0, 4).concat(['Parse.gs'], CORE.slice(4)),
  'budget-parser.gs': ['Parse.gs'],
  'budget-core.gs': CORE,
};

const src = path.join(__dirname, 'apps-script');
const out = path.join(__dirname, 'dist');
fs.mkdirSync(out, { recursive: true });

Object.keys(TARGETS).forEach((target) => {
  const banner = [
    '/**',
    ' * 이 파일은 build.js가 생성합니다. 직접 고치지 마세요.',
    ' * 원본: ' + TARGETS[target].map((f) => 'apps-script/' + f).join(', '),
    ' *',
    target === 'bundle.gs'
      ? ' * 사용법: 전체를 복사해 Apps Script의 Code.gs에 붙여넣으세요 (기존 내용은 지우고).'
      : ' * 사용법: 전체를 복사해 Apps Script의 같은 이름 파일에 붙여넣으세요.',
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
