/** 초기 데이터. 이미 행이 있으면 건드리지 않는다. */

const SEED_CATEGORIES = [
  // [id, 이름, 상위, 종류, 아이콘]
  ['cat_delivery',   '배달',     '',            'expense', '🛵'],
  ['cat_dining',     '외식',     '',            'expense', '🍚'],
  ['cat_cafe',       '카페',     'cat_dining',  'expense', '☕'],
  ['cat_grocery',    '마트',     '',            'expense', '🛒'],
  ['cat_convenience','편의점',   '',            'expense', '🏪'],
  ['cat_transport',  '교통',     '',            'expense', '🚌'],
  ['cat_medical',    '의료',     '',            'expense', '🏥'],
  ['cat_beauty',     '미용',     '',            'expense', '💇'],
  ['cat_shopping',   '쇼핑',     '',            'expense', '🛍️'],
  ['cat_hobby',      '취미',     '',            'expense', '🎨'],
  ['cat_travel',     '여행',     '',            'expense', '✈️'],
  ['cat_gathering',  '모임',     '',            'expense', '🍻'],

  // 매달 자동으로 나가는 것들. 고정지출 화면이 이 세 개를 본다.
  ['cat_subscription','구독',    '',            'expense', '📺'],
  ['cat_sub_digital','디지털',   'cat_subscription', 'expense', '☁️'],  // 아이클라우드·구글드라이브·클로드
  ['cat_sub_media',  '미디어',   'cat_subscription', 'expense', '🎬'],  // 넷플릭스 등
  ['cat_telecom',    '통신',     '',            'expense', '📱'],
  ['cat_donation',   '기부',     '',            'expense', '💗'],

  ['cat_event',      '경조사',   '',            'expense', '🎁'],
  ['cat_finance',    '금융비용', '',            'expense', '💸'],
  ['cat_etc',        '기타',     '',            'expense', '📦'],
  ['cat_unknown',    '미분류',   '',            'expense', '❓'],

  ['cat_salary',     '급여',     '',            'income',  '💰'],
  // 더치페이로 돌려받은 돈. 진짜 수입이 아니라 지출 환급이라
  // 수입 합계에서 빼고 원 지출과 상계한다.
  ['cat_settle_in',  '정산입금', '',            'income',  '🔁'],

  // 이체는 지출이 아니다. 예산·통계에서 제외된다.
  ['cat_cardbill',   '카드대금', '',            'transfer', '💳'],
  ['cat_saving',     '저축투자', '',            'transfer', '🏦'],
  ['cat_withdraw',   '현금인출', '',            'transfer', '🏧'],
];

const SEED_ACCOUNTS = [
  // [id, 이름, 종류, 발급사, 뒷자리, 마감일, 결제일]
  ['acc_woori',   '우리은행',   'checking', '우리은행',  '', '', ''],
  ['acc_hyundai', '현대카드',   'card',     '현대카드',  '', '', 5],
  ['acc_cash',    '현금',       'cash',     '',          '', '', ''],
];

function seedCategories_() {
  if (readAll_('Category').length) return;
  SEED_CATEGORIES.forEach(function (row, i) {
    append_('Category', {
      id: row[0], name: row[1], parentId: row[2],
      kind: row[3], icon: row[4], sortOrder: i,
    });
  });
}

function seedAccounts_() {
  if (readAll_('Account').length) return;
  SEED_ACCOUNTS.forEach(function (row) {
    append_('Account', {
      id: row[0], name: row[1], type: row[2], issuer: row[3],
      last4: row[4], closingDay: row[5], billingDay: row[6], active: true,
    });
  });
}

/**
 * 기본 분류 규칙.
 *
 * priority가 작을수록 먼저 본다. 포함 검사라서 좁은 것을 먼저 둬야 한다
 * ("이마트24"가 "이마트"에 먼저 걸리면 편의점이 마트로 분류된다).
 *
 * 여기 없는 곳은 처음 한 번 물어보고, 같은 답이 두 번 나오면 스스로 외운다.
 */
const SEED_RULES = [
  // [우선순위, 패턴, 카테고리]
  [10, '이마트24',     'cat_convenience'],   // "이마트"보다 먼저
  [10, 'GS25',         'cat_convenience'],
  [10, '쿠팡이츠',     'cat_delivery'],      // "쿠팡"보다 먼저
  [10, '쿠팡플레이',   'cat_sub_media'],

  [20, 'CU',           'cat_convenience'],
  [20, '세븐일레븐',   'cat_convenience'],
  [20, '미니스톱',     'cat_convenience'],

  [20, '이마트',       'cat_grocery'],
  [20, '홈플러스',     'cat_grocery'],
  [20, '롯데마트',     'cat_grocery'],
  [20, '하나로마트',   'cat_grocery'],
  [20, '코스트코',     'cat_grocery'],

  [20, '스타벅스',     'cat_cafe'],
  [20, '컴포즈',       'cat_cafe'],
  [20, '메가커피',     'cat_cafe'],
  [20, '메가엠지씨',   'cat_cafe'],
  [20, '투썸',         'cat_cafe'],
  [20, '이디야',       'cat_cafe'],
  [20, '빽다방',       'cat_cafe'],
  [20, '할리스',       'cat_cafe'],
  [20, '파스쿠찌',     'cat_cafe'],
  [20, '공차',         'cat_cafe'],

  [20, '배달의민족',   'cat_delivery'],
  [20, '배민',         'cat_delivery'],
  [20, '요기요',       'cat_delivery'],

  [20, '티머니',       'cat_transport'],
  [20, '카카오티',     'cat_transport'],
  [20, '카카오T',      'cat_transport'],
  [20, '코레일',       'cat_transport'],
  [20, 'SRT',          'cat_transport'],
  [20, '고속버스',     'cat_transport'],
  [20, '주차',         'cat_transport'],

  [20, '올리브영',     'cat_beauty'],

  [20, '쿠팡',         'cat_shopping'],
  [20, '무신사',       'cat_shopping'],
  [20, '11번가',       'cat_shopping'],
  [20, '지마켓',       'cat_shopping'],
  [20, '옥션',         'cat_shopping'],
  [20, '알리익스프레스','cat_shopping'],
  [20, '다이소',       'cat_shopping'],

  // 매달 빠져나가는 것들. 고정지출 화면이 이 둘을 본다.
  [20, 'APPLE',        'cat_sub_digital'],
  [20, '애플',         'cat_sub_digital'],
  [20, 'ICLOUD',       'cat_sub_digital'],
  [20, 'GOOGLE',       'cat_sub_digital'],
  [20, '구글',         'cat_sub_digital'],
  [20, 'ANTHROPIC',    'cat_sub_digital'],
  [20, 'CLAUDE',       'cat_sub_digital'],
  [20, 'OPENAI',       'cat_sub_digital'],
  [20, 'NETFLIX',      'cat_sub_media'],
  [20, '넷플릭스',     'cat_sub_media'],
  [20, '티빙',         'cat_sub_media'],
  [20, '웨이브',       'cat_sub_media'],
  [20, '왓챠',         'cat_sub_media'],
  [20, 'YOUTUBE',      'cat_sub_media'],
  [20, '유튜브',       'cat_sub_media'],
  [20, '멜론',         'cat_sub_media'],
  [20, 'SPOTIFY',      'cat_sub_media'],

  [20, 'SKT',          'cat_telecom'],
  [20, 'KT',           'cat_telecom'],
  [20, 'LGU',          'cat_telecom'],
  [20, '유플러스',     'cat_telecom'],

  // 넓은 낱말은 마지막에 본다
  [100, '커피',        'cat_cafe'],
  [100, '카페',        'cat_cafe'],
  [100, '약국',        'cat_medical'],
  [100, '병원',        'cat_medical'],
  [100, '의원',        'cat_medical'],
  [100, '치과',        'cat_medical'],
  [100, '한의원',      'cat_medical'],
  [100, '미용실',      'cat_beauty'],
  [100, '헤어',        'cat_beauty'],
  [100, '네일',        'cat_beauty'],
  [100, '택시',        'cat_transport'],
  [100, '연회비',      'cat_finance'],
  [100, '수수료',      'cat_finance'],
];

/**
 * 간편결제 대행사.
 * 가맹점명이 "네이버파이낸셜"로 뭉개져 무엇을 샀는지 알 수 없으므로
 * 이름으로는 분류하지 않고 좌표나 사용자에게 맡긴다.
 */
const SEED_PASSTHROUGH = [
  '네이버파이낸셜', '네이버페이', '카카오페이', '토스페이먼츠', '페이코', 'NHN페이코',
];

function seedRules_() {
  if (readAll_('Rule').length) return;
  SEED_RULES.forEach(function (row) {
    append_('Rule', {
      id: newId_('rul'), priority: row[0], matchType: 'contains',
      pattern: row[1], categoryId: row[2], source: 'builtin',
      hitCount: 0, lastUsedAt: '',
    });
  });
}

function seedMerchants_() {
  if (readAll_('Merchant').length) return;
  SEED_PASSTHROUGH.forEach(function (name) {
    append_('Merchant', {
      id: newId_('mch'), normalizedName: normalizeMerchant_(name), displayName: name,
      defaultCategoryId: '', isPassthrough: true, alwaysAsk: false,
      aliases: '', hitCount: 0,
    });
  });
}

/**
 * 빠진 시드만 채운다.
 *
 * setup() 의 시드 함수들은 시트가 비어 있을 때만 넣는다 — 사용자가 일부러
 * 지운 항목을 되살리지 않기 위해서다. 그래서 이미 쓰던 시트에 새 카테고리나
 * 새 기본 규칙이 추가되면 들어가지 않는다. 그때 이걸 실행한다.
 *
 * 있는 것은 건드리지 않고 없는 것만 더한다. 여러 번 실행해도 안전하다.
 */
function resync() {
  const added = { categories: 0, rules: 0, merchants: 0 };

  const haveCategory = {};
  readAll_('Category').forEach(function (c) { haveCategory[c.id] = true; });
  SEED_CATEGORIES.forEach(function (row, i) {
    if (haveCategory[row[0]]) return;
    append_('Category', {
      id: row[0], name: row[1], parentId: row[2],
      kind: row[3], icon: row[4], sortOrder: i,
    });
    added.categories++;
  });

  // 직접 만든 규칙(learned)은 세지 않는다. 기본 규칙만 채운다.
  const haveRule = {};
  readAll_('Rule').forEach(function (r) {
    if (r.source === 'builtin') haveRule[String(r.pattern)] = true;
  });
  SEED_RULES.forEach(function (row) {
    if (haveRule[row[1]]) return;
    append_('Rule', {
      id: newId_('rul'), priority: row[0], matchType: 'contains',
      pattern: row[1], categoryId: row[2], source: 'builtin',
      hitCount: 0, lastUsedAt: '',
    });
    added.rules++;
  });

  const haveMerchant = {};
  readAll_('Merchant').forEach(function (m) { haveMerchant[m.normalizedName] = true; });
  SEED_PASSTHROUGH.forEach(function (name) {
    const normalized = normalizeMerchant_(name);
    if (haveMerchant[normalized]) return;
    append_('Merchant', {
      id: newId_('mch'), normalizedName: normalized, displayName: name,
      defaultCategoryId: '', isPassthrough: true, alwaysAsk: false,
      aliases: '', hitCount: 0,
    });
    added.merchants++;
  });

  Logger.log('카테고리 ' + added.categories + '개 · 기본 규칙 ' + added.rules +
             '개 · 간편결제 ' + added.merchants + '개를 더했습니다.');
  return added;
}
