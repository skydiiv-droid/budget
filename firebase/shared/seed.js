/**
 * 처음 한 번 넣는 것들. 이미 있으면 건드리지 않는다.
 *
 * 규칙이 하나도 없으면 무엇을 읽든 전부 미분류로 떨어진다.
 * 자주 가는 곳을 미리 넣어 두면 첫날부터 대부분 자동으로 갈린다.
 */

export const CAT_VERSION = 2;

/**
 * 두 단계다. 큰 갈래를 먼저 고르고, 필요하면 그 안에서 더 좁힌다.
 * "배달 · 외식 · 카페" 를 한 줄에 늘어놓는 것보다 "식비" 하나를 먼저 고르는 편이
 * 고를 때 생각이 적다.
 *
 * 갈래가 하나뿐인 것은 굳이 쪼개지 않는다 — 교통 · 쇼핑처럼.
 */
export const CATEGORIES = [
  // [id, 이름, 상위, 종류, 아이콘]
  ['cat_food',        '식비',   '',             'expense', '🍚'],
  ['cat_delivery',    '배달',   'cat_food',     'expense', '🛵'],
  ['cat_dining',      '외식',   'cat_food',     'expense', '🍽️'],
  ['cat_cafe',        '카페',   'cat_food',     'expense', '☕'],
  ['cat_convenience', '편의점', 'cat_food',     'expense', '🏪'],
  ['cat_grocery',     '마트',   'cat_food',     'expense', '🛒'],

  ['cat_life',        '생활',   '',             'expense', '🏠'],
  ['cat_medical',     '의료',   'cat_life',     'expense', '🏥'],
  ['cat_beauty',      '미용',   'cat_life',     'expense', '💇'],
  ['cat_daily',       '생필품', 'cat_life',     'expense', '🧻'],

  ['cat_leisure',     '여가',   '',             'expense', '🎈'],
  ['cat_hobby',       '취미',   'cat_leisure',  'expense', '🎨'],
  ['cat_travel',      '여행',   'cat_leisure',  'expense', '✈️'],
  ['cat_gathering',   '모임',   'cat_leisure',  'expense', '🍻'],

  ['cat_regular',     '정기',   '',             'expense', '🔁'],
  ['cat_subscription','구독',   'cat_regular',  'expense', '📺'],
  ['cat_telecom',     '통신',   'cat_regular',  'expense', '📱'],
  ['cat_insurance',   '보험',   'cat_regular',  'expense', '🛡️'],
  ['cat_donation',    '기부',   'cat_regular',  'expense', '💗'],

  ['cat_transport',   '교통',   '',             'expense', '🚌'],
  ['cat_shopping',    '쇼핑',   '',             'expense', '🛍️'],
  ['cat_event',       '경조사', '',             'expense', '🎁'],
  ['cat_finance',     '금융',   '',             'expense', '💸'],
  ['cat_etc',         '기타',   '',             'expense', '📦'],
  ['cat_unknown',     '미분류', '',             'expense', '❓'],

  ['cat_salary',      '급여',     '',           'income',  '💰'],
  ['cat_settle_in',   '정산입금', '',           'income',  '🔁'],

  ['cat_cardbill',    '카드대금', '',           'transfer', '💳'],
  ['cat_saving',      '저축투자', '',           'transfer', '🏦'],
  ['cat_withdraw',    '현금인출', '',           'transfer', '🏧'],
];

/**
 * 예전에 쓰던 칸. 목록에는 안 보이지만 지난 거래가 가리키고 있어 이름은 남긴다.
 */
export const LEGACY_CATEGORIES = [
  ['cat_sub_digital', '구독(디지털)', 'cat_regular', 'expense', '☁️'],
  ['cat_sub_media',   '구독(미디어)', 'cat_regular', 'expense', '🎬'],
];

/**
 * priority 가 작을수록 먼저 본다. 포함 검사라서 좁은 것을 먼저 둬야 한다
 * ("이마트24"가 "이마트"에 먼저 걸리면 편의점이 마트로 분류된다).
 */
export const RULES = [
  [10, '이마트24',      'cat_convenience'],
  [10, 'GS25',          'cat_convenience'],
  [10, '쿠팡이츠',      'cat_delivery'],
  [10, '쿠팡플레이',    'cat_subscription'],

  [20, 'CU',            'cat_convenience'],
  [20, '세븐일레븐',    'cat_convenience'],
  [20, '미니스톱',      'cat_convenience'],
  [20, '이마트',        'cat_grocery'],
  [20, '홈플러스',      'cat_grocery'],
  [20, '롯데마트',      'cat_grocery'],
  [20, '하나로마트',    'cat_grocery'],
  [20, '코스트코',      'cat_grocery'],

  [20, '스타벅스',      'cat_cafe'],
  [20, '컴포즈',        'cat_cafe'],
  [20, '메가커피',      'cat_cafe'],
  [20, '메가엠지씨',    'cat_cafe'],
  [20, '투썸',          'cat_cafe'],
  [20, '이디야',        'cat_cafe'],
  [20, '빽다방',        'cat_cafe'],
  [20, '할리스',        'cat_cafe'],
  [20, '파스쿠찌',      'cat_cafe'],
  [20, '공차',          'cat_cafe'],

  [20, '배달의민족',    'cat_delivery'],
  [20, '배민',          'cat_delivery'],
  [20, '요기요',        'cat_delivery'],

  [20, '티머니',        'cat_transport'],
  [20, '카카오티',      'cat_transport'],
  [20, '카카오T',       'cat_transport'],
  [20, '코레일',        'cat_transport'],
  [20, 'SRT',           'cat_transport'],
  [20, '고속버스',      'cat_transport'],
  [20, '주차',          'cat_transport'],

  [20, '올리브영',      'cat_beauty'],

  [20, '쿠팡',          'cat_shopping'],
  [20, '무신사',        'cat_shopping'],
  [20, '11번가',        'cat_shopping'],
  [20, '지마켓',        'cat_shopping'],
  [20, '옥션',          'cat_shopping'],
  [20, '알리익스프레스','cat_shopping'],
  [20, '다이소',        'cat_shopping'],

  [20, 'APPLE',         'cat_subscription'],
  [20, '애플',          'cat_subscription'],
  [20, 'ICLOUD',        'cat_subscription'],
  [20, 'GOOGLE',        'cat_subscription'],
  [20, '구글',          'cat_subscription'],
  [20, 'ANTHROPIC',     'cat_subscription'],
  [20, 'CLAUDE',        'cat_subscription'],
  [20, 'OPENAI',        'cat_subscription'],
  [20, 'NETFLIX',       'cat_subscription'],
  [20, '넷플릭스',      'cat_subscription'],
  [20, '티빙',          'cat_subscription'],
  [20, '웨이브',        'cat_subscription'],
  [20, '왓챠',          'cat_subscription'],
  [20, 'YOUTUBE',       'cat_subscription'],
  [20, '유튜브',        'cat_subscription'],
  [20, '멜론',          'cat_subscription'],
  [20, 'SPOTIFY',       'cat_subscription'],

  [20, 'SKT',           'cat_telecom'],
  [20, 'KT',            'cat_telecom'],
  [20, 'LGU',           'cat_telecom'],
  [20, '유플러스',      'cat_telecom'],

  // 넓은 낱말은 마지막에 본다
  [100, '커피',         'cat_cafe'],
  [100, '카페',         'cat_cafe'],
  [100, '약국',         'cat_medical'],
  [100, '병원',         'cat_medical'],
  [100, '의원',         'cat_medical'],
  [100, '치과',         'cat_medical'],
  [100, '한의원',       'cat_medical'],
  [100, '미용실',       'cat_beauty'],
  [100, '헤어',         'cat_beauty'],
  [100, '네일',         'cat_beauty'],
  [100, '택시',         'cat_transport'],
  [100, '연회비',       'cat_finance'],
  [100, '수수료',       'cat_finance'],
];

/**
 * 간편결제 대행사. 가맹점명이 뭉개져 무엇을 샀는지 알 수 없으므로
 * 이름으로는 분류하지 않고 좌표나 사람에게 맡긴다.
 */
export const PASSTHROUGH = [
  '네이버파이낸셜', '네이버페이', '카카오페이', '토스페이먼츠', '페이코', 'NHN페이코',
];

export const ACCOUNTS = [
  // [id, 이름, 종류, 카드종류, 발급사, 결제일]
  ['acc_woori',    '우리은행',        'checking', '',       '우리은행', ''],
  ['acc_hd_emart', '현대 이마트Plus', 'card',     'credit', '현대카드', 10],
  ['acc_hd_mirae', '현대 미래에셋',   'card',     'credit', '현대카드', 10],
  ['acc_cash',     '현금',            'cash',     '',       '',         ''],
];

export const SETTINGS = {
  monthlyIncome: 0,
  // 급여일을 주기 시작으로 두면 "쓸 수 있는 돈"이 지갑 현실과 맞는다
  cycleMode: 'calendar',        // 'calendar' | 'payday'
  extraHolidays: [],
  variableBudget: 0,
  debtStartAmount: 0,
  debtTargetDate: '',
  cycleStartDay: 1,
};

/** 카테고리를 화면에 쓰기 좋은 모양으로. */
export const categoryDocs = () => [
  ...CATEGORIES.map(([id, name, parentId, kind, icon], i) =>
    ({ id, name, parentId, kind, icon, sortOrder: i, hidden: false })),
  ...LEGACY_CATEGORIES.map(([id, name, parentId, kind, icon], i) =>
    ({ id, name, parentId, kind, icon, sortOrder: 900 + i, hidden: true })),
];

export const ruleDocs = () => RULES.map(([priority, pattern, categoryId], i) =>
  ({ id: `rul_seed_${i}`, priority, matchType: 'contains', pattern, categoryId,
     source: 'builtin', hitCount: 0 }));

export const merchantDocs = () => PASSTHROUGH.map((name, i) =>
  ({ id: `mch_seed_${i}`, normalizedName: name, displayName: name,
     defaultCategoryId: null, isPassthrough: true, alwaysAsk: false }));

export const accountDocs = () => ACCOUNTS.map(([id, name, type, cardType, issuer, billingDay]) =>
  ({ id, name, type, cardType, issuer, billingDay, rate: 0, creditLimit: 0,
     payFromId: '', linkedAccountId: '', balance: 0, balanceAt: '', active: true }));
