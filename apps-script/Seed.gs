/** 초기 데이터. 이미 행이 있으면 건드리지 않는다. */

const SEED_CATEGORIES = [
  // [id, 이름, 상위, 종류, 아이콘]
  ['cat_delivery',  '배달',     '',            'expense', '🛵'],
  ['cat_dining',    '외식',     '',            'expense', '🍚'],
  ['cat_cafe',      '카페',     'cat_dining',  'expense', '☕'],
  ['cat_grocery',   '마트',     '',            'expense', '🛒'],
  ['cat_convenience','편의점',  '',            'expense', '🏪'],
  ['cat_transport', '교통',     '',            'expense', '🚌'],
  ['cat_medical',   '의료',     '',            'expense', '🏥'],
  ['cat_beauty',    '미용',     '',            'expense', '💇'],
  ['cat_shopping',  '쇼핑',     '',            'expense', '🛍️'],
  ['cat_hobby',     '취미',     '',            'expense', '🎨'],
  ['cat_subscription','구독',   '',            'expense', '📺'],
  ['cat_event',     '경조사',   '',            'expense', '🎁'],
  ['cat_finance',   '금융비용', '',            'expense', '💸'],
  ['cat_etc',       '기타',     '',            'expense', '❓'],

  ['cat_salary',    '급여',     '',            'income',  '💰'],

  // 이체는 지출이 아니다. 예산·통계에서 제외된다.
  ['cat_cardbill',  '카드대금', '',            'transfer', '💳'],
  ['cat_saving',    '저축투자', '',            'transfer', '🏦'],
  ['cat_withdraw',  '현금인출', '',            'transfer', '🏧'],
];

// 태그는 카테고리와 직교하는 축. 여행 중 외식은 카테고리=외식, 태그=여행.
const SEED_TAGS = ['여행', '쇼핑', '업무', '회수예정'];

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

function seedTags_() {
  if (readAll_('Tag').length) return;
  SEED_TAGS.forEach(function (name) {
    append_('Tag', { id: newId_('tag'), name: name });
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
