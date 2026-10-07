/**
 * 처음 한 번 넣는 것들. 이미 있으면 건드리지 않는다.
 *
 * 규칙이 하나도 없으면 무엇을 읽든 전부 미분류로 떨어진다.
 * 자주 가는 곳을 미리 넣어 두면 첫날부터 대부분 자동으로 갈린다.
 */

export const CAT_VERSION = 3;

/**
 * 처음에 넣어 둔 계좌 정보를 고쳐야 할 때 올린다.
 *
 * 카드 결제일을 5일로 넣어 뒀는데 실제로는 10일이었다. 쓰는 사람이 직접 고친
 * 값은 건드리지 않고, 내가 잘못 넣은 기본값만 바로잡는다.
 */
export const ACCOUNT_VERSION = 2;

/** [계좌 id, 고칠 것, 그 값이 아직 내가 넣은 채일 때만] */
export const ACCOUNT_FIXES = [
  ['acc_hd_emart', { billingDay: 10, cardType: 'credit' }, { billingDay: 5 }],
  ['acc_hd_mirae', { billingDay: 10, cardType: 'credit' }, { billingDay: 5 }],
];

/**
 * 두 단계다. 큰 갈래를 먼저 고르고, 그 안에서 더 좁힌다.
 * "배달 · 외식 · 카페" 를 한 줄에 늘어놓는 것보다 "식비" 하나를 먼저 고르는 편이
 * 고를 때 생각이 적다.
 *
 * 하위를 넉넉히 둔다. 없는 칸은 만들어야 하지만 남는 칸은 안 쓰면 그만이고,
 * 안 쓰는 칸은 카테고리 관리에서 지울 수 있다. **세 단계로는 가지 않는다** —
 * 고르는 화면이 두 단계까지만 펼친다.
 *
 * 깊이를 바꿀 때 id 는 그대로 둔다. 거래가 id 를 가리키고 있어서,
 * 바꾸면 지난 기록이 길을 잃는다. 이름과 상위만 옮긴다.
 */
export const CATEGORIES = [
  // [id, 이름, 상위, 종류, 아이콘]
  ['cat_food',        '식비',        '',            'expense', '🍚'],
  ['cat_delivery',    '배달',        'cat_food',    'expense', '🛵'],
  ['cat_dining',      '외식',        'cat_food',    'expense', '🍽️'],
  ['cat_cafe',        '카페',        'cat_food',    'expense', '☕'],
  ['cat_convenience', '편의점',      'cat_food',    'expense', '🏪'],
  ['cat_grocery',     '마트 · 장보기', 'cat_food',  'expense', '🛒'],
  ['cat_canteen',     '구내식당',    'cat_food',    'expense', '🍱'],
  ['cat_alcohol',     '주류',        'cat_food',    'expense', '🍺'],

  ['cat_life',        '생활',        '',            'expense', '🏠'],
  ['cat_daily',       '생필품',      'cat_life',    'expense', '🧻'],
  ['cat_rent',        '주거 · 관리비', 'cat_life',  'expense', '🏢'],
  ['cat_utility',     '공과금',      'cat_life',    'expense', '💡'],
  ['cat_laundry',     '세탁',        'cat_life',    'expense', '🧺'],
  ['cat_repair',      '수리 · 설치', 'cat_life',    'expense', '🔧'],
  ['cat_pet',         '반려동물',    'cat_life',    'expense', '🐾'],

  // 의료는 생활 아래 한 칸이었다. 3교대로 도는 사람에게는 쓰는 자리가 넓어
  // 상위로 올리고 안을 나눴다.
  ['cat_medical',     '의료 · 건강', '',            'expense', '🏥'],
  ['cat_clinic',      '병원 · 진료', 'cat_medical', 'expense', '🩺'],
  ['cat_pharmacy',    '약국',        'cat_medical', 'expense', '💊'],
  ['cat_dental',      '치과',        'cat_medical', 'expense', '🦷'],
  ['cat_optical',     '안경 · 렌즈', 'cat_medical', 'expense', '👓'],
  ['cat_checkup',     '건강검진',    'cat_medical', 'expense', '📋'],
  ['cat_supplement',  '영양제',      'cat_medical', 'expense', '🧴'],
  ['cat_fitness',     '운동 · 헬스', 'cat_medical', 'expense', '🏃'],

  ['cat_beauty',      '미용',        '',            'expense', '💇'],
  ['cat_hair',        '미용실',      'cat_beauty',  'expense', '✂️'],
  ['cat_cosmetic',    '화장품',      'cat_beauty',  'expense', '💄'],
  ['cat_nail',        '네일 · 왁싱', 'cat_beauty',  'expense', '💅'],
  ['cat_skincare',    '피부 · 관리', 'cat_beauty',  'expense', '🧖'],

  ['cat_leisure',     '여가',        '',            'expense', '🎈'],
  ['cat_hobby',       '취미',        'cat_leisure', 'expense', '🎨'],
  ['cat_travel',      '여행 · 숙박', 'cat_leisure', 'expense', '✈️'],
  ['cat_gathering',   '모임',        'cat_leisure', 'expense', '🍻'],
  ['cat_culture',     '문화 · 공연', 'cat_leisure', 'expense', '🎬'],
  ['cat_book',        '도서',        'cat_leisure', 'expense', '📚'],
  ['cat_game',        '게임',        'cat_leisure', 'expense', '🎮'],

  ['cat_regular',     '정기',        '',            'expense', '🔁'],
  ['cat_subscription','구독',        'cat_regular', 'expense', '📺'],
  ['cat_telecom',     '통신',        'cat_regular', 'expense', '📱'],
  ['cat_insurance',   '보험',        'cat_regular', 'expense', '🛡️'],
  ['cat_donation',    '기부',        'cat_regular', 'expense', '💗'],
  ['cat_membership',  '회비 · 멤버십', 'cat_regular', 'expense', '🎫'],

  ['cat_transport',   '교통',        '',            'expense', '🚌'],
  ['cat_transit',     '대중교통',    'cat_transport', 'expense', '🚇'],
  ['cat_taxi',        '택시',        'cat_transport', 'expense', '🚕'],
  ['cat_intercity',   '기차 · 고속버스', 'cat_transport', 'expense', '🚄'],
  ['cat_fuel',        '주유',        'cat_transport', 'expense', '⛽'],
  ['cat_parking',     '주차 · 통행료', 'cat_transport', 'expense', '🅿️'],
  ['cat_carcare',     '차량 정비',   'cat_transport', 'expense', '🔩'],

  ['cat_shopping',    '쇼핑',        '',            'expense', '🛍️'],
  ['cat_clothing',    '의류',        'cat_shopping', 'expense', '👕'],
  ['cat_bag',         '신발 · 가방', 'cat_shopping', 'expense', '👟'],
  ['cat_digital',     '디지털 · 가전', 'cat_shopping', 'expense', '💻'],
  ['cat_furniture',   '가구 · 인테리어', 'cat_shopping', 'expense', '🛋️'],

  ['cat_event',       '경조사',      '',            'expense', '🎁'],
  ['cat_congrats',    '축의 · 조의', 'cat_event',   'expense', '🧧'],
  ['cat_present',     '선물',        'cat_event',   'expense', '🎀'],
  ['cat_seasonal',    '명절',        'cat_event',   'expense', '🌕'],

  ['cat_finance',     '금융',        '',            'expense', '💸'],
  ['cat_interest',    '이자',        'cat_finance', 'expense', '🏦'],
  ['cat_fee',         '수수료',      'cat_finance', 'expense', '🧾'],
  ['cat_tax',         '세금',        'cat_finance', 'expense', '🏛️'],
  ['cat_annualfee',   '연회비',      'cat_finance', 'expense', '💳'],

  ['cat_etc',         '기타',        '',            'expense', '📦'],
  ['cat_unknown',     '미분류',      '',            'expense', '❓'],

  ['cat_salary',      '급여',        '',            'income',  '💰'],
  ['cat_allowance',   '수당 · 초과근무', 'cat_salary', 'income', '🌙'],
  ['cat_bonus',       '상여 · 성과급', 'cat_salary', 'income',  '🎯'],
  ['cat_settle_in',   '정산입금',    '',            'income',  '🔁'],
  ['cat_income_etc',  '기타수입',    '',            'income',  '✨'],
  ['cat_refund',      '환급',        'cat_income_etc', 'income', '↩️'],
  ['cat_interest_in', '이자 · 배당', 'cat_income_etc', 'income', '📈'],
  ['cat_resale',      '중고판매',    'cat_income_etc', 'income', '🏷️'],

  // 나간 돈이지만 쓴 돈은 아니다. 지출로 세면 예산이 통째로 부풀어 오른다.
  ['cat_cardbill',    '카드대금',    '',            'transfer', '💳'],
  ['cat_saving',      '저축 · 적금', '',            'transfer', '🏦'],
  ['cat_housingfund', '청약',        '',            'transfer', '🏘️'],
  ['cat_invest',      '투자 · 주식', '',            'transfer', '📊'],
  ['cat_pension',     '연금',        '',            'transfer', '👵'],
  ['cat_withdraw',    '현금인출',    '',            'transfer', '🏧'],
  ['cat_selftransfer','내 계좌 이동', '',           'transfer', '🔄'],
];

/**
 * 예전에 쓰던 칸. 목록에는 안 보이지만 지난 거래가 가리키고 있어 이름은 남긴다.
 */
export const LEGACY_CATEGORIES = [
  ['cat_sub_digital', '구독(디지털)', 'cat_regular', 'expense', '☁️'],
  ['cat_sub_media',   '구독(미디어)', 'cat_regular', 'expense', '🎬'],
];

/**
 * priority 가 작을수록 먼저 본다. 포함 검사라서 **좁은 것을 먼저 둬야 한다**
 * ("이마트24"가 "이마트"에 먼저 걸리면 편의점이 마트로 분류된다).
 *
 * 같은 priority 끼리의 순서는 믿지 않는다. 규칙은 Firestore 에서 읽어 오므로
 * 적어 둔 순서가 아니라 문서 id 순으로 온다. 겹치는 둘은 priority 를 달리 둔다.
 */
export const RULES = [
  // ── 좁은 것부터 ───────────────────────────────────────
  [10, '이마트24',        'cat_convenience'],
  [10, 'GS25',            'cat_convenience'],
  [10, '쿠팡이츠',        'cat_delivery'],
  [10, '쿠팡플레이',      'cat_subscription'],
  [10, '노브랜드버거',    'cat_dining'],
  [10, '동물병원',        'cat_pet'],
  [10, '스파오',          'cat_clothing'],
  [10, 'APPLESTORE',      'cat_digital'],
  [10, '애플스토어',      'cat_digital'],
  [10, '다비치안경',      'cat_optical'],
  [10, '세탁특공대',      'cat_laundry'],
  [10, '하이마트',        'cat_digital'],

  // ── 편의점 · 마트 ─────────────────────────────────────
  [20, 'CU',              'cat_convenience'],
  [20, '세븐일레븐',      'cat_convenience'],
  [20, '미니스톱',        'cat_convenience'],
  [20, '이마트',          'cat_grocery'],
  [20, '홈플러스',        'cat_grocery'],
  [20, '롯데마트',        'cat_grocery'],
  [20, '하나로마트',      'cat_grocery'],
  [20, '코스트코',        'cat_grocery'],
  [20, '트레이더스',      'cat_grocery'],
  [20, '노브랜드',        'cat_grocery'],
  [20, '마켓컬리',        'cat_grocery'],
  [20, '컬리',            'cat_grocery'],
  [20, '오아시스마켓',    'cat_grocery'],
  [20, '더프레시',        'cat_grocery'],
  [20, '롯데슈퍼',        'cat_grocery'],

  // ── 카페 ──────────────────────────────────────────────
  [20, '스타벅스',        'cat_cafe'],
  [20, '컴포즈',          'cat_cafe'],
  [20, '메가커피',        'cat_cafe'],
  [20, '메가엠지씨',      'cat_cafe'],
  [20, '투썸',            'cat_cafe'],
  [20, '이디야',          'cat_cafe'],
  [20, '빽다방',          'cat_cafe'],
  [20, '할리스',          'cat_cafe'],
  [20, '파스쿠찌',        'cat_cafe'],
  [20, '공차',            'cat_cafe'],
  [20, '더벤티',          'cat_cafe'],
  [20, '매머드',          'cat_cafe'],
  [20, '커피빈',          'cat_cafe'],
  [20, '탐앤탐스',        'cat_cafe'],
  [20, '폴바셋',          'cat_cafe'],
  [20, '블루보틀',        'cat_cafe'],
  [20, '던킨',            'cat_cafe'],
  [20, '설빙',            'cat_cafe'],
  [20, '배스킨',          'cat_cafe'],

  // ── 배달 · 외식 ───────────────────────────────────────
  [20, '배달의민족',      'cat_delivery'],
  [20, '배민',            'cat_delivery'],
  [20, '요기요',          'cat_delivery'],
  [20, '땡겨요',          'cat_delivery'],
  [20, '교촌',            'cat_delivery'],
  [20, 'BBQ',             'cat_delivery'],
  [20, 'BHC',             'cat_delivery'],
  [20, '굽네',            'cat_delivery'],
  [20, '푸라닭',          'cat_delivery'],
  [20, '도미노',          'cat_delivery'],
  [20, '피자',            'cat_delivery'],
  [20, '김밥천국',        'cat_dining'],
  [20, '맥도날드',        'cat_dining'],
  [20, '버거킹',          'cat_dining'],
  [20, '롯데리아',        'cat_dining'],
  [20, '서브웨이',        'cat_dining'],
  [20, '백종원',          'cat_dining'],
  [20, '한신포차',        'cat_gathering'],
  [20, '이자카야',        'cat_alcohol'],

  // ── 교통 ──────────────────────────────────────────────
  [20, '티머니',          'cat_transit'],
  [20, '카카오티',        'cat_taxi'],
  [20, '카카오T',         'cat_taxi'],
  [20, '서울교통공사',    'cat_transit'],
  [20, '지하철',          'cat_transit'],
  [20, '코레일',          'cat_intercity'],
  [20, 'SRT',             'cat_intercity'],
  [20, '고속버스',        'cat_intercity'],
  [20, '시외버스',        'cat_intercity'],
  [20, '타다',            'cat_taxi'],
  [20, 'GS칼텍스',        'cat_fuel'],
  [20, 'SK에너지',        'cat_fuel'],
  [20, 'S-OIL',           'cat_fuel'],
  [20, '에쓰오일',        'cat_fuel'],
  [20, '현대오일뱅크',    'cat_fuel'],
  [20, '하이패스',        'cat_parking'],
  [20, '도로공사',        'cat_parking'],

  // ── 미용 ──────────────────────────────────────────────
  [20, '올리브영',        'cat_cosmetic'],
  [20, '아리따움',        'cat_cosmetic'],
  [20, '이니스프리',      'cat_cosmetic'],
  [20, '에뛰드',          'cat_cosmetic'],
  [20, '미샤',            'cat_cosmetic'],
  [20, '시코르',          'cat_cosmetic'],
  [20, '롭스',            'cat_cosmetic'],
  [20, '토니모리',        'cat_cosmetic'],

  // ── 쇼핑 ──────────────────────────────────────────────
  [20, '쿠팡',            'cat_shopping'],
  [20, '11번가',          'cat_shopping'],
  [20, '지마켓',          'cat_shopping'],
  [20, '옥션',            'cat_shopping'],
  [20, '알리익스프레스',  'cat_shopping'],
  [20, '테무',            'cat_shopping'],
  [20, '무신사',          'cat_clothing'],
  [20, '지그재그',        'cat_clothing'],
  [20, '에이블리',        'cat_clothing'],
  [20, '유니클로',        'cat_clothing'],
  [20, '탑텐',            'cat_clothing'],
  [20, '29CM',            'cat_clothing'],
  [20, 'W컨셉',           'cat_clothing'],
  [20, 'ABC마트',         'cat_bag'],
  [20, '나이키',          'cat_bag'],
  [20, '아디다스',        'cat_bag'],
  [20, '크록스',          'cat_bag'],
  [20, '다이소',          'cat_daily'],
  [20, '전자랜드',        'cat_digital'],
  [20, '이케아',          'cat_furniture'],
  [20, '한샘',            'cat_furniture'],
  [20, '오늘의집',        'cat_furniture'],

  // ── 구독 ──────────────────────────────────────────────
  [20, 'APPLE',           'cat_subscription'],
  [20, '애플',            'cat_subscription'],
  [20, 'ICLOUD',          'cat_subscription'],
  [20, 'GOOGLE',          'cat_subscription'],
  [20, '구글',            'cat_subscription'],
  [20, 'ANTHROPIC',       'cat_subscription'],
  [20, 'CLAUDE',          'cat_subscription'],
  [20, 'OPENAI',          'cat_subscription'],
  [20, 'CHATGPT',         'cat_subscription'],
  [20, 'NETFLIX',         'cat_subscription'],
  [20, '넷플릭스',        'cat_subscription'],
  [20, '티빙',            'cat_subscription'],
  [20, '웨이브',          'cat_subscription'],
  [20, '왓챠',            'cat_subscription'],
  [20, '디즈니',          'cat_subscription'],
  [20, 'DISNEY',          'cat_subscription'],
  [20, 'YOUTUBE',         'cat_subscription'],
  [20, '유튜브',          'cat_subscription'],
  [20, '멜론',            'cat_subscription'],
  [20, 'SPOTIFY',         'cat_subscription'],
  [20, '지니뮤직',        'cat_subscription'],
  [20, '밀리의서재',      'cat_subscription'],
  [20, 'NOTION',          'cat_subscription'],
  [20, 'ADOBE',           'cat_subscription'],
  [20, '어도비',          'cat_subscription'],
  [20, '라프텔',          'cat_subscription'],

  // ── 통신 ──────────────────────────────────────────────
  [20, 'SKT',             'cat_telecom'],
  [20, 'SK텔레콤',        'cat_telecom'],
  [20, 'KT',              'cat_telecom'],
  [20, 'LGU',             'cat_telecom'],
  [20, '유플러스',        'cat_telecom'],
  [20, '알뜰폰',          'cat_telecom'],
  [20, '헬로모바일',      'cat_telecom'],

  // ── 문화 · 도서 · 게임 ────────────────────────────────
  [20, 'CGV',             'cat_culture'],
  [20, '메가박스',        'cat_culture'],
  [20, '롯데시네마',      'cat_culture'],
  [20, '인터파크티켓',    'cat_culture'],
  [20, '티켓링크',        'cat_culture'],
  [20, '예술의전당',      'cat_culture'],
  [20, '교보문고',        'cat_book'],
  [20, 'YES24',           'cat_book'],
  [20, '예스24',          'cat_book'],
  [20, '알라딘',          'cat_book'],
  [20, '영풍문고',        'cat_book'],
  [20, '리디',            'cat_book'],
  [20, 'STEAM',           'cat_game'],
  [20, '스팀',            'cat_game'],
  [20, '넥슨',            'cat_game'],
  [20, '넷마블',          'cat_game'],
  [20, '닌텐도',          'cat_game'],
  [20, '플레이스테이션',  'cat_game'],

  // ── 여행 ──────────────────────────────────────────────
  [20, '야놀자',          'cat_travel'],
  [20, '여기어때',        'cat_travel'],
  [20, '아고다',          'cat_travel'],
  [20, 'AGODA',           'cat_travel'],
  [20, '에어비앤비',      'cat_travel'],
  [20, '대한항공',        'cat_travel'],
  [20, '아시아나',        'cat_travel'],
  [20, '제주항공',        'cat_travel'],
  [20, '티웨이',          'cat_travel'],
  [20, '진에어',          'cat_travel'],
  [20, '에어부산',        'cat_travel'],
  [20, '하나투어',        'cat_travel'],
  [20, '모두투어',        'cat_travel'],
  [20, '마이리얼트립',    'cat_travel'],

  // ── 보험 · 공과금 · 세금 ──────────────────────────────
  [20, '삼성생명',        'cat_insurance'],
  [20, '교보생명',        'cat_insurance'],
  [20, '한화생명',        'cat_insurance'],
  [20, '삼성화재',        'cat_insurance'],
  [20, '현대해상',        'cat_insurance'],
  [20, 'DB손해보험',      'cat_insurance'],
  [20, 'KB손해보험',      'cat_insurance'],
  [20, '메리츠',          'cat_insurance'],
  [20, '라이나',          'cat_insurance'],
  [20, '실손',            'cat_insurance'],
  [20, '한국전력',        'cat_utility'],
  [20, '도시가스',        'cat_utility'],
  [20, '수도사업',        'cat_utility'],
  [20, '상수도',          'cat_utility'],
  [20, '홈택스',          'cat_tax'],
  [20, '위택스',          'cat_tax'],
  [20, '자동차세',        'cat_tax'],

  // ── 의료 · 건강 ───────────────────────────────────────
  [20, '아이허브',        'cat_supplement'],
  [20, 'IHERB',           'cat_supplement'],
  [20, '크린토피아',      'cat_laundry'],
  [20, '유니세프',        'cat_donation'],
  [20, '굿네이버스',      'cat_donation'],
  [20, '세이브더칠드런',  'cat_donation'],
  [20, '월드비전',        'cat_donation'],
  [20, '적십자',          'cat_donation'],

  // ── 넓은 낱말은 마지막에 본다 ─────────────────────────
  [100, '커피',           'cat_cafe'],
  [100, '카페',           'cat_cafe'],
  [100, '구내식당',       'cat_canteen'],
  [100, '주유',           'cat_fuel'],
  [100, '택시',           'cat_taxi'],
  [100, '주차',           'cat_parking'],
  [100, '통행료',         'cat_parking'],
  [100, '세차',           'cat_carcare'],
  [100, '카센터',         'cat_carcare'],
  [100, '타이어',         'cat_carcare'],
  [100, '약국',           'cat_pharmacy'],
  [100, '병원',           'cat_clinic'],
  [100, '의원',           'cat_clinic'],
  [100, '내과',           'cat_clinic'],
  [100, '외과',           'cat_clinic'],
  [100, '이비인후과',     'cat_clinic'],
  [100, '피부과',         'cat_clinic'],
  [100, '안과',           'cat_clinic'],
  [100, '산부인과',       'cat_clinic'],
  [100, '한의원',         'cat_clinic'],
  [100, '치과',           'cat_dental'],
  [100, '안경',           'cat_optical'],
  [100, '렌즈',           'cat_optical'],
  [100, '건강검진',       'cat_checkup'],
  [100, '영양제',         'cat_supplement'],
  [100, '헬스',           'cat_fitness'],
  [100, '피트니스',       'cat_fitness'],
  [100, '요가',           'cat_fitness'],
  [100, '필라테스',       'cat_fitness'],
  [100, '클라이밍',       'cat_fitness'],
  [100, '수영장',         'cat_fitness'],
  [100, '미용실',         'cat_hair'],
  [100, '헤어',           'cat_hair'],
  [100, '살롱',           'cat_hair'],
  [100, '네일',           'cat_nail'],
  [100, '왁싱',           'cat_nail'],
  [100, '속눈썹',         'cat_nail'],
  [100, '에스테틱',       'cat_skincare'],
  [100, '마사지',         'cat_skincare'],
  [100, '세탁',           'cat_laundry'],
  [100, '빨래방',         'cat_laundry'],
  [100, '관리비',         'cat_rent'],
  [100, '월세',           'cat_rent'],
  [100, '애견',           'cat_pet'],
  [100, '펫샵',           'cat_pet'],
  [100, '축의',           'cat_congrats'],
  [100, '조의',           'cat_congrats'],
  [100, '부의',           'cat_congrats'],
  [100, '화환',           'cat_congrats'],
  [100, '연회비',         'cat_annualfee'],
  [100, '수수료',         'cat_fee'],
  [100, '이자',           'cat_interest'],
  [100, '호텔',           'cat_travel'],
  [100, '리조트',         'cat_travel'],
  [100, '게스트하우스',   'cat_travel'],
  [100, '서점',           'cat_book'],
  [100, '영화관',         'cat_culture'],
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
  // 따로 만든 근무표 앱에서 듀티를 읽어 온다. 읽기만 한다.
  dutyUrl: '',
  dutyPerson: '',
};

/** 카테고리를 화면에 쓰기 좋은 모양으로. */
export const categoryDocs = () => [
  ...CATEGORIES.map(([id, name, parentId, kind, icon], i) =>
    ({ id, name, parentId, kind, icon, sortOrder: i, hidden: false })),
  ...LEGACY_CATEGORIES.map(([id, name, parentId, kind, icon], i) =>
    ({ id, name, parentId, kind, icon, sortOrder: 900 + i, hidden: true })),
];

/**
 * 기본 규칙을 더 넣을 때 올린다.
 *
 * 쓰던 사람에게는 seedIfEmpty 가 돌지 않아 새 규칙이 영영 안 들어온다.
 */
export const RULE_VERSION = 1;

/** 규칙 문서 id. 낱말로 짓는다 — 번호로 지으면 중간에 끼워 넣을 때 뜻이 밀린다. */
export const ruleId = (pattern) => `rul_seed_${encodeURIComponent(pattern)}`;

export const ruleDocs = () => RULES.map(([priority, pattern, categoryId]) =>
  ({ id: ruleId(pattern), priority, matchType: 'contains', pattern, categoryId,
     source: 'builtin', hitCount: 0 }));

export const merchantDocs = () => PASSTHROUGH.map((name, i) =>
  ({ id: `mch_seed_${i}`, normalizedName: name, displayName: name,
     defaultCategoryId: null, isPassthrough: true, alwaysAsk: false }));

export const accountDocs = () => ACCOUNTS.map(([id, name, type, cardType, issuer, billingDay]) =>
  ({ id, name, type, cardType, issuer, billingDay, rate: 0, creditLimit: 0,
     payFromId: '', linkedAccountId: '', balance: 0, balanceAt: '', active: true }));
