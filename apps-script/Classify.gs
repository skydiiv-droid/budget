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
 * 사용자가 미분류 건을 고쳐줄 때 호출한다.
 * 같은 가맹점을 두 번 연속 같은 카테고리로 고르면 기본 카테고리로 승격한다.
 * (한 번 잘못 고른 것이 영구 고착되는 걸 막으려고 2회로 둔다)
 */
function learn_(merchantRaw, categoryId) {
  const normalized = normalizeMerchant_(merchantRaw);
  if (!normalized) return;

  let merchant = findBy_('Merchant', 'normalizedName', normalized);
  if (!merchant) {
    merchant = {
      id: newId_('mch'), normalizedName: normalized, displayName: merchantRaw,
      defaultCategoryId: '', isPassthrough: false, alwaysAsk: false,
      aliases: '', hitCount: 0,
    };
    append_('Merchant', merchant);
  }

  const seen = readAll_('Transaction').filter(function (t) {
    return normalizeMerchant_(t.merchantRaw) === normalized && t.categoryId === categoryId;
  });

  if (seen.length >= 1 && !merchant.defaultCategoryId) {
    // 이번 교정까지 두 번째 -> 승격
    update_('Merchant', merchant.id, { defaultCategoryId: categoryId });
  }
  update_('Merchant', merchant.id, { hitCount: (Number(merchant.hitCount) || 0) + 1 });
}
