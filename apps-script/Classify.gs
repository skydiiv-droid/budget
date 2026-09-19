/**
 * 분류기. 위에서 걸리면 멈춘다.
 *
 *   1. Merchant.alwaysAsk       -> 물어봄
 *   2. Merchant.isPassthrough   -> 위치로 시도, 안 되면 물어봄 (네이버페이 등)
 *   3. Merchant.defaultCategory -> 확정
 *   4. Rule (learned)           -> 확정
 *   5. Rule (builtin, contains) -> 확정
 *   6. 위치 매칭                -> 확정
 *   7. 실패                     -> 미분류. 알림으로 물어본다.
 *
 * 간편결제는 가맹점이 "네이버파이낸셜"로 뭉개져 이름으로는 손을 쓸 수 없다.
 * 좌표는 뭉개지지 않으므로 6번이 그 구멍을 메운다.
 */

function classify_(merchantRaw, amount, location) {
  const normalized = normalizeMerchant_(merchantRaw);
  const nearby = nearbyCategory_(location);

  if (!normalized) {
    return nearby.confident
      ? { categoryId: nearby.categoryId, reason: 'location', nearby: nearby }
      : { categoryId: null, reason: 'no-merchant', nearby: nearby };
  }

  const merchant = findBy_('Merchant', 'normalizedName', normalized);
  if (merchant) {
    if (merchant.alwaysAsk === true || merchant.alwaysAsk === 'TRUE') {
      return { categoryId: null, reason: 'always-ask', merchantId: merchant.id, nearby: nearby };
    }
    if (merchant.isPassthrough === true || merchant.isPassthrough === 'TRUE') {
      // 간편결제. 이름은 못 믿지만 좌표가 확실하면 그걸 쓴다.
      return nearby.confident
        ? { categoryId: nearby.categoryId, reason: 'passthrough-location',
            merchantId: merchant.id, nearby: nearby }
        : { categoryId: null, reason: 'passthrough', merchantId: merchant.id, nearby: nearby };
    }
    if (merchant.defaultCategoryId) {
      return { categoryId: merchant.defaultCategoryId, reason: 'merchant-default',
               merchantId: merchant.id, nearby: nearby };
    }
  }

  const rules = readAll_('Rule').sort(function (a, b) {
    // learned 규칙을 builtin보다 먼저 본다.
    const w = function (r) { return (r.source === 'learned' ? 0 : 1000) + (Number(r.priority) || 0); };
    return w(a) - w(b);
  });

  for (let i = 0; i < rules.length; i++) {
    if (matchRule_(rules[i], normalized, merchantRaw, amount)) {
      update_('Rule', rules[i].id, {
        hitCount: (Number(rules[i].hitCount) || 0) + 1,
        lastUsedAt: nowIso_(),
      });
      return { categoryId: rules[i].categoryId, reason: 'rule:' + rules[i].id,
               merchantId: merchant ? merchant.id : null, nearby: nearby };
    }
  }

  if (nearby.confident) {
    return { categoryId: nearby.categoryId, reason: 'location',
             merchantId: merchant ? merchant.id : null, nearby: nearby };
  }

  return { categoryId: null, reason: 'no-match',
           merchantId: merchant ? merchant.id : null, nearby: nearby };
}

// ------------------------------------------------------------- 위치 학습

const LOCATION_RADIUS_M = 60;      // 같은 자리로 볼 반경
const LOCATION_MIN_SAMPLES = 3;    // 이만큼 쌓여야 자동 확정
const LOCATION_MIN_SHARE = 0.7;    // 그 중 이 비율 이상이 같은 카테고리여야 한다

/**
 * 과거에 같은 자리에서 뭘로 분류했는지 본다.
 * 표본이 적거나 카테고리가 갈리면 confident=false로 두고 제안만 한다.
 */
function nearbyCategory_(location) {
  const empty = { categoryId: null, confident: false, samples: 0, share: 0 };
  if (!location || location.lat === null || location.lat === undefined) return empty;
  if (!location.lon && location.lon !== 0) return empty;

  const counts = {};
  let total = 0;
  readAll_('Transaction').forEach(function (t) {
    if (!t.categoryId || t.type !== 'expense') return;
    if (t.lat === '' || t.lat === null || t.lat === undefined) return;
    const distance = haversineMeters_(Number(location.lat), Number(location.lon),
                                      Number(t.lat), Number(t.lon));
    if (distance > LOCATION_RADIUS_M) return;
    counts[t.categoryId] = (counts[t.categoryId] || 0) + 1;
    total++;
  });
  if (!total) return empty;

  let bestId = null;
  let bestCount = 0;
  Object.keys(counts).forEach(function (id) {
    if (counts[id] > bestCount) { bestCount = counts[id]; bestId = id; }
  });

  const share = bestCount / total;
  return {
    categoryId: bestId,
    samples: total,
    share: Math.round(share * 100) / 100,
    confident: total >= LOCATION_MIN_SAMPLES && share >= LOCATION_MIN_SHARE,
  };
}

/** 두 좌표 사이 거리(m). */
function haversineMeters_(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = function (d) { return d * Math.PI / 180; };
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function matchRule_(rule, normalized, raw, amount) {
  const pattern = String(rule.pattern || '');
  if (!pattern) return false;
  switch (rule.matchType) {
    case 'exactMerchant':
      return normalized === normalizeMerchant_(pattern);
    case 'contains':
      return String(raw || '').indexOf(pattern) >= 0 || normalized.indexOf(pattern) >= 0;
    case 'regex':
      try { return new RegExp(pattern).test(String(raw || '')); } catch (e) { return false; }
    case 'amountRange': {
      const parts = pattern.split('-');
      const lo = parseAmount_(parts[0]);
      const hi = parseAmount_(parts[1]);
      return amount !== null && amount >= lo && amount <= hi;
    }
    default:
      return false;
  }
}

/** "(주)스타벅스코리아 역삼점1234" -> "스타벅스코리아역삼점" */
function normalizeMerchant_(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\(주\)|\(유\)|㈜|주식회사/g, '')
    .replace(/\d+$/g, '')
    .replace(/[\s\-_.,*]/g, '')
    .trim();
}

/**
 * 가맹점명에서 브랜드로 쓸 만한 낱말을 골라 준다.
 *
 * "컴포즈커피발산" 을 카페로 정했을 때, 다음에 "컴포즈커피강남" 이 오면
 * 또 물어보는 게 맞을까? 프랜차이즈는 지점명이 붙어 이름이 매번 달라진다.
 * 그래서 규칙을 걸 범위를 정할 수 있어야 하고, 그 후보를 여기서 뽑는다.
 *
 * 짚이는 게 없으면 조용히 "이 이름 그대로"를 권한다. 억지로 낱말을 잘라내면
 * 엉뚱한 곳까지 같이 분류돼 버린다.
 */
function suggestKeyword_(merchantRaw) {
  const normalized = normalizeMerchant_(merchantRaw);
  if (!normalized) return { scope: 'exact', keyword: '', reason: 'no-merchant' };

  // 1. 이미 아는 브랜드가 이름 안에 들어 있으면 그것을 쓴다
  //    "컴포즈커피발산" 안의 "컴포즈"
  const known = readAll_('Rule')
    .filter(function (r) { return r.matchType === 'contains' && r.pattern; })
    .map(function (r) { return String(r.pattern); })
    .filter(function (pattern) {
      return pattern.length >= 2 && normalized.indexOf(pattern) >= 0;
    })
    .sort(function (a, b) { return b.length - a.length; });   // 긴 쪽이 더 구체적이다
  if (known.length) {
    return { scope: 'contains', keyword: known[0], reason: 'known-brand' };
  }

  // 2. 과거에 다녀온 곳들과 앞부분이 겹치면 그 부분이 브랜드다
  //    "컴포즈커피발산" 과 "컴포즈커피강남" -> "컴포즈커피"
  const prefix = sharedPrefix_(normalized);
  if (prefix.length >= 3) {
    return { scope: 'contains', keyword: prefix, reason: 'shared-prefix' };
  }

  return { scope: 'exact', keyword: normalized, reason: 'no-clue' };
}

/** 과거 가맹점들과 겹치는 가장 긴 앞부분. 같은 이름은 세지 않는다. */
function sharedPrefix_(normalized) {
  let best = '';
  readAll_('Transaction').forEach(function (t) {
    const other = normalizeMerchant_(t.merchantRaw);
    if (!other || other === normalized) return;
    let i = 0;
    while (i < other.length && i < normalized.length && other.charAt(i) === normalized.charAt(i)) i++;
    if (i > best.length) best = normalized.slice(0, i);
  });
  return best;
}

/**
 * 사용자가 미분류 건을 고쳐줄 때 호출한다.
 *
 *   scope 'once'     이 건만. 규칙을 만들지 않는다
 *   scope 'exact'    이 가맹점명과 똑같은 것만
 *   scope 'contains' keyword 가 들어간 모든 가맹점
 *
 * 같은 범위의 규칙이 이미 있으면 새로 만들지 않고 카테고리만 바꾼다.
 * 생각이 바뀌어 다시 고를 때 규칙이 쌓이면 안 된다.
 */
function learn_(merchantRaw, categoryId, scope, keyword) {
  const normalized = normalizeMerchant_(merchantRaw);
  if (!normalized || !categoryId) return { scope: 'once', reason: 'nothing-to-learn' };
  if (scope === 'once') return { scope: 'once' };

  const merchant = ensureMerchant_(normalized, merchantRaw);

  if (scope === 'contains') {
    const pattern = String(keyword || '').trim();
    if (pattern.length < 2) return { scope: 'once', reason: 'keyword-too-short' };

    const existing = readAll_('Rule').filter(function (r) {
      return r.matchType === 'contains' && String(r.pattern) === pattern && r.source === 'learned';
    })[0];

    if (existing) {
      update_('Rule', existing.id, { categoryId: categoryId });
      return { scope: 'contains', keyword: pattern, ruleId: existing.id, updated: true };
    }

    const rule = {
      id: newId_('rul'),
      priority: 10,          // 직접 정한 것이니 기본 규칙보다 먼저 본다
      matchType: 'contains',
      pattern: pattern,
      categoryId: categoryId,
      source: 'learned',
      hitCount: 0,
      lastUsedAt: '',
    };
    append_('Rule', rule);
    return { scope: 'contains', keyword: pattern, ruleId: rule.id };
  }

  // exact — 가맹점 자체에 기본 카테고리를 단다. 규칙 표를 늘리지 않는다.
  update_('Merchant', merchant.id, { defaultCategoryId: categoryId });
  return { scope: 'exact', keyword: normalized, merchantId: merchant.id };
}

function ensureMerchant_(normalized, displayName) {
  const found = findBy_('Merchant', 'normalizedName', normalized);
  if (found) {
    update_('Merchant', found.id, { hitCount: (Number(found.hitCount) || 0) + 1 });
    return found;
  }
  const merchant = {
    id: newId_('mch'), normalizedName: normalized, displayName: displayName || normalized,
    defaultCategoryId: '', isPassthrough: false, alwaysAsk: false,
    aliases: '', hitCount: 1,
  };
  append_('Merchant', merchant);
  return merchant;
}

/**
 * 새로 만든 규칙을 아직 분류되지 않은 과거 거래에도 적용한다.
 * 규칙 하나를 정하면 밀려 있던 같은 가게 건들이 한꺼번에 정리된다.
 * 이미 분류된 건은 건드리지 않는다 — 사용자가 일부러 다르게 넣었을 수 있다.
 */
function applyToPending_(categoryId, scope, keyword) {
  if (scope === 'once' || !keyword) return 0;
  let count = 0;

  readAll_('Transaction').forEach(function (t) {
    if (t.status !== 'pendingCategory' || t.categoryId) return;
    const normalized = normalizeMerchant_(t.merchantRaw);
    if (!normalized) return;

    const hit = scope === 'contains'
      ? normalized.indexOf(keyword) >= 0
      : normalized === keyword;
    if (!hit) return;

    update_('Transaction', t.id, { categoryId: categoryId, status: 'confirmed' });
    count++;
  });
  return count;
}

/** 지금 걸려 있는 분류 규칙을 한눈에 본다. */
function listRules() {
  const categoryName = function (id) {
    const c = findBy_('Category', 'id', id);
    return c ? c.name : id;
  };

  const fromMerchants = readAll_('Merchant')
    .filter(function (m) { return m.defaultCategoryId; })
    .map(function (m) {
      return { 범위: '이름이 같으면', 패턴: m.normalizedName,
               카테고리: categoryName(m.defaultCategoryId), 출처: '직접' };
    });

  const fromRules = readAll_('Rule').map(function (r) {
    return {
      범위: r.matchType === 'contains' ? '포함하면' : '이름이 같으면',
      패턴: r.pattern,
      카테고리: categoryName(r.categoryId),
      출처: r.source === 'learned' ? '직접' : '기본',
      쓰인횟수: Number(r.hitCount) || 0,
    };
  });

  const all = fromMerchants.concat(fromRules);
  all.forEach(function (row) {
    Logger.log([row.출처, row.범위, row.패턴, '->', row.카테고리,
                row.쓰인횟수 === undefined ? '' : '(' + row.쓰인횟수 + '회)'].join(' '));
  });
  Logger.log('규칙 ' + all.length + '개');
  return all;
}

/** 잘못 만든 규칙을 지운다. 패턴 문자열로 지목한다. */
function forgetRule(payload) {
  const pattern = String((payload && payload.pattern) || '').trim();
  if (!pattern) return { status: 'error', reason: 'need-pattern' };

  let removed = 0;

  const sheet = sheet_('Rule');
  const headers = SCHEMA.Rule;
  const values = sheet.getDataRange().getValues();
  const patternCol = headers.indexOf('pattern');
  const sourceCol = headers.indexOf('source');
  // 뒤에서부터 지워야 행 번호가 밀리지 않는다
  for (let r = values.length - 1; r >= 1; r--) {
    if (String(values[r][patternCol]) !== pattern) continue;
    if (values[r][sourceCol] !== 'learned') continue;   // 기본 규칙은 남긴다
    sheet.deleteRow(r + 1);
    removed++;
  }

  const merchant = findBy_('Merchant', 'normalizedName', normalizeMerchant_(pattern));
  if (merchant && merchant.defaultCategoryId) {
    update_('Merchant', merchant.id, { defaultCategoryId: '' });
    removed++;
  }

  Logger.log(removed ? ('규칙 ' + removed + '개를 지웠습니다: ' + pattern)
                     : ('지울 규칙이 없습니다: ' + pattern));
  return { status: 'ok', removed: removed };
}
