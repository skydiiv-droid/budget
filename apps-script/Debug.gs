/**
 * 편집기에서 직접 돌려보는 점검 함수들.
 * 단축어가 문제인지 서버가 문제인지 가르는 데 쓴다.
 */

/**
 * 가짜 문자 한 건을 넣어 파이프라인이 도는지 본다.
 * 단축어 없이 서버만 시험하므로, 여기서 성공하면 남은 문제는 아이폰 쪽이다.
 *
 * 편집기 함수 목록에서 selfTest 를 골라 실행하고 로그를 본다.
 */
function selfTest() {
  const sample = [
    '[Web발신]',
    '우리 09/19 14:16',
    '*123456',
    '입금 10,000원',
    '홍길동',
    '잔액 500,000원',
  ].join('\n');

  const before = readAll_('RawMessage').length;
  const result = ingest({ body: sample, sender: 'selfTest', receivedAt: new Date().toISOString() });
  const after = readAll_('RawMessage').length;

  Logger.log('결과: ' + JSON.stringify(result, null, 2));
  Logger.log('RawMessage: ' + before + '건 -> ' + after + '건');

  if (after > before) {
    Logger.log('서버는 정상입니다. 수집이 안 된다면 아이폰 단축어 쪽을 보세요.');
  } else if (result.status === 'duplicate') {
    Logger.log('같은 문자가 이미 있습니다. 한 번 더 실행하면 시각이 달라져 들어갑니다.');
  } else {
    Logger.log('서버에서 막혔습니다: ' + result.status + ' / ' + (result.reason || ''));
  }
  return result;
}

/** 설정이 빠진 곳이 있는지 훑는다. */
function checkSetup() {
  const problems = [];

  try {
    getIngestToken_();
  } catch (e) {
    problems.push('스크립트 속성 INGEST_TOKEN 이 없습니다. 프로젝트 설정에서 추가하세요.');
  }

  Object.keys(SCHEMA).forEach(function (name) {
    if (!spreadsheet_().getSheetByName(name)) {
      problems.push('시트 없음: ' + name + ' — setup() 을 실행하세요.');
    }
  });

  if (!readAll_('Category').length) {
    problems.push('카테고리가 비어 있습니다 — setup() 을 실행하세요.');
  }

  // 토큰 자체는 찍지 않는다. 모양만 본다.
  try {
    const raw = PropertiesService.getScriptProperties().getProperty('INGEST_TOKEN') || '';
    const trimmed = raw.trim();
    Logger.log('토큰 길이 ' + trimmed.length + '자');
    if (raw !== trimmed) {
      Logger.log('! 속성 값 앞뒤에 공백이나 줄바꿈이 있습니다 (' + (raw.length - trimmed.length) +
                 '자). 지금은 떼고 견주므로 동작하지만, 속성에서도 지워 두는 편이 낫습니다.');
    }
    if (/[\s&?#%+/]/.test(trimmed)) {
      Logger.log('! 토큰 가운데에 공백이나 & ? # % + / 가 있습니다. 주소에 붙일 때 깨집니다.');
    }
  } catch (e) {
    problems.push(String(e.message));
  }

  if (problems.length) {
    problems.forEach(function (p) { Logger.log('✗ ' + p); });
  } else {
    Logger.log('✓ 설정에 빠진 곳이 없습니다.');
    Logger.log('  파서 버전 ' + CONFIG.parserVersion +
               ' · 문자 ' + readAll_('RawMessage').length + '건' +
               ' · 거래 ' + readAll_('Transaction').length + '건');
  }
  return problems;
}

/**
 * 시트를 못 찾을 때 무엇이 잘못됐는지 그대로 찍는다.
 * 추측하지 않도록, 실제로 무엇이 있고 무엇이 없는지 보여 준다.
 */
function diagnose() {
  let ss = null;
  try {
    ss = spreadsheet_();
  } catch (e) {
    Logger.log('✗ ' + e.message);
    return { ok: false, reason: String(e.message) };
  }

  Logger.log('파일   : ' + ss.getName());
  Logger.log('주소   : ' + ss.getUrl());
  const names = ss.getSheets().map(function (s) { return s.getName(); });
  Logger.log('시트 ' + names.length + '개: ' + names.join(', '));

  const missing = Object.keys(SCHEMA).filter(function (n) { return names.indexOf(n) < 0; });
  if (!missing.length) {
    Logger.log('✓ 스키마의 시트가 전부 있습니다.');
    return { ok: true, sheets: names };
  }

  Logger.log('없는 시트: ' + missing.join(', '));
  Logger.log('만들어 봅니다…');
  try {
    const made = ensureSheets_();
    const after = spreadsheet_().getSheets().map(function (s) { return s.getName(); });
    const still = Object.keys(SCHEMA).filter(function (n) { return after.indexOf(n) < 0; });
    Logger.log(still.length ? ('✗ 아직 없음: ' + still.join(', '))
                            : ('✓ ' + made + '개를 만들었습니다. 이제 다시 열어 보세요.'));
    return { ok: !still.length, made: made, missing: still };
  } catch (e) {
    Logger.log('✗ 만들다 실패: ' + e.message);
    return { ok: false, reason: String(e.message) };
  }
}

/**
 * 어디서 시간이 새는지 잰다.
 *
 * "느리다"를 추측으로 고치면 몇 번이고 헛돈다. 편집기에서 이걸 실행하면
 * 각 단계가 몇 밀리초인지 그대로 찍힌다. 300ms 를 넘는 줄이 범인이다.
 */
function benchmark() {
  const t0 = Date.now();
  const mark = function (label, fn) {
    const t = Date.now();
    let note = '';
    try { note = fn(); } catch (e) { note = '실패: ' + e.message; }
    const ms = Date.now() - t;
    Logger.log((ms + 'ms').padStart(7) + '  ' + label + (note ? '  (' + note + ')' : ''));
    return ms;
  };

  Logger.log('── 한 번씩 재기 ──');
  mark('스프레드시트 핸들', function () { return spreadsheet_().getName(); });
  mark('토큰 읽기', function () { return getIngestToken_().length + '자'; });

  Logger.log('── 시트별 읽기 (캐시 비우고) ──');
  Object.keys(SCHEMA).forEach(function (name) {
    invalidate_(name);
    mark(name, function () { return readAll_(name).length + '행'; });
  });

  Logger.log('── 화면이 부르는 것들 ──');
  mark('ledger()', function () { const l = ledger(); return l.debt.items.length + '개 빚'; });
  mark('pendingItems_()', function () { return pendingItems_().length + '건'; });
  mark('unparsedItems_()', function () { return unparsedItems_().length + '건'; });

  Logger.log('── 전부 (화면이 한 번 여는 것과 같음) ──');
  const total = mark('apiLoad()', function () {
    const d = apiLoad(getIngestToken_());
    return JSON.stringify(d).length + '바이트';
  });

  Logger.log('합계 ' + (Date.now() - t0) + 'ms');
  if (total > 5000) Logger.log('! apiLoad 가 5초를 넘습니다. 위에서 가장 큰 줄을 보세요.');
  return total;
}
