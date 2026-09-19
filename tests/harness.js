/**
 * Apps Script 코드를 node에서 돌리기 위한 얇은 셸.
 *
 * Apps Script는 로컬 테스트 러너가 없어서, .gs 파일을 읽어 node 컨텍스트에
 * 올리고 필요한 전역(Utilities 등)만 흉내 낸다. 파서는 순수 함수라 이걸로 충분하다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'apps-script');

function pad(n, len) { return String(n).padStart(len, '0'); }

const Utilities = {
  formatDate(date, _tz, format) {
    // 테스트에 필요한 포맷만 지원한다 (시간대는 로컬로 취급)
    return format
      .replace(/yyyy/g, date.getFullYear())
      .replace(/MM/g, pad(date.getMonth() + 1, 2))
      .replace(/dd/g, pad(date.getDate(), 2))
      .replace(/HH/g, pad(date.getHours(), 2))
      .replace(/mm/g, pad(date.getMinutes(), 2))
      .replace(/ss/g, pad(date.getSeconds(), 2))
      .replace(/'/g, '');
  },
  // 실제 getUuid는 매번 다른 값을 준다. 같은 값을 돌려주면 id가 겹쳐
  // update_ 와 findBy_ 가 엉뚱한 행을 집는다.
  //
  // newId_ 는 대시를 지우고 앞 16자만 쓰므로, 증가 번호를 맨 앞에 둬야 한다.
  // 뒤에 두면 잘려나가 모든 id가 같아진다.
  getUuid: (() => {
    let n = 0;
    return () => String(++n).padStart(8, '0') + '-aaaa-bbbb-cccc-dddddddddddd';
  })(),
  computeDigest(_algo, input) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    }
    return String(hash).split('').map((c) => c.charCodeAt(0));
  },
  DigestAlgorithm: { MD5: 'MD5' },
  Charset: { UTF_8: 'UTF-8' },
};

function load(files, extraGlobals = {}) {
  const context = vm.createContext({
    Utilities,
    console,
    Date,
    JSON,
    RegExp,
    Math,
    Number,
    String,
    Object,
    Array,
    // Pattern 시트는 node에 없다. Layer 2를 건너뛰고 Layer 1만 시험한다.
    readAll_: () => [],
    ...extraGlobals,
  });
  files.forEach((file) => {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  });
  return context;
}

module.exports = { load };
