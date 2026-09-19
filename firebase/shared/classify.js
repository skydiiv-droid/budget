/**
 * 분류기. 위에서 걸리면 멈춘다.
 *
 *   1. merchant.alwaysAsk        -> 물어봄
 *   2. merchant.isPassthrough    -> 위치로 시도, 안 되면 물어봄 (네이버페이 등)
 *   3. merchant.defaultCategoryId-> 확정
 *   4. rule (learned)            -> 확정
 *   5. rule (builtin, contains)  -> 확정
 *   6. 위치 매칭                 -> 확정
 *   7. 실패                      -> 미분류
 *
 * 간편결제는 가맹점이 "네이버파이낸셜"로 뭉개져 이름으로는 손을 쓸 수 없다.
 * 좌표는 뭉개지지 않으므로 6번이 그 구멍을 메운다.
 *
 * 시트도 Firestore도 모르는 순수 함수다. 필요한 것은 전부 인자로 받는다.
 */
import { normalizeMerchant } from './parse.js';

export const LOCATION_RADIUS_M = 60;      // 같은 자리로 볼 반경
export const LOCATION_MIN_SAMPLES = 3;    // 이만큼 쌓여야 자동 확정
export const LOCATION_MIN_SHARE = 0.7;    // 그중 이 비율 이상이 같은 카테고리여야 한다

/**
 * @param {string} merchantRaw  문자에서 읽은 가맹점명
 * @param {object} ctx  { merchants, rules, transactions, location }
 */
export function classify(merchantRaw, ctx = {}) {
  const { merchants = [], rules = [], transactions = [], location = null } = ctx;
  const normalized = normalizeMerchant(merchantRaw);
  const nearby = nearbyCategory(location, transactions);

  if (!normalized) {
    return nearby.confident
      ? { categoryId: nearby.categoryId, reason: 'location', nearby }
      : { categoryId: null, reason: 'no-merchant', nearby };
  }

  const merchant = merchants.find((m) => m.normalizedName === normalized);
  if (merchant) {
    if (merchant.alwaysAsk) {
      return { categoryId: null, reason: 'always-ask', merchantId: merchant.id, nearby };
    }
    if (merchant.isPassthrough) {
      // 간편결제. 이름은 못 믿지만 좌표가 확실하면 그걸 쓴다.
      return nearby.confident
        ? { categoryId: nearby.categoryId, reason: 'passthrough-location', merchantId: merchant.id, nearby }
        : { categoryId: null, reason: 'passthrough', merchantId: merchant.id, nearby };
    }
    if (merchant.defaultCategoryId) {
      return { categoryId: merchant.defaultCategoryId, reason: 'merchant-default',
               merchantId: merchant.id, nearby };
    }
  }

  // 직접 정한 규칙을 기본 규칙보다 먼저 본다
  const ordered = [...rules].sort((a, b) => {
    const weight = (r) => (r.source === 'learned' ? 0 : 1000) + (Number(r.priority) || 0);
    return weight(a) - weight(b);
  });

  for (const rule of ordered) {
    if (matchRule(rule, normalized, merchantRaw)) {
      return { categoryId: rule.categoryId, reason: `rule:${rule.id}`,
               ruleId: rule.id, merchantId: merchant?.id ?? null, nearby };
    }
  }

  if (nearby.confident) {
    return { categoryId: nearby.categoryId, reason: 'location',
             merchantId: merchant?.id ?? null, nearby };
  }

  return { categoryId: null, reason: 'no-match', merchantId: merchant?.id ?? null, nearby };
}

export function matchRule(rule, normalized, raw) {
  const pattern = String(rule.pattern || '');
  if (!pattern) return false;

  switch (rule.matchType) {
    case 'exactMerchant':
      return normalized === normalizeMerchant(pattern);
    case 'contains':
      return String(raw || '').includes(pattern) || normalized.includes(pattern);
    case 'regex':
      try { return new RegExp(pattern).test(String(raw || '')); } catch { return false; }
    default:
      return false;
  }
}

/**
 * 과거에 같은 자리에서 뭘로 분류했는지 본다.
 * 표본이 적거나 카테고리가 갈리면 확정하지 않고 제안만 한다.
 */
export function nearbyCategory(location, transactions = []) {
  const empty = { categoryId: null, confident: false, samples: 0, share: 0 };
  if (!location || location.lat == null || location.lon == null) return empty;

  const counts = new Map();
  let total = 0;

  for (const t of transactions) {
    if (!t.categoryId || t.type !== 'expense') continue;
    if (t.lat == null || t.lon == null || t.lat === '') continue;
    if (haversineMeters(Number(location.lat), Number(location.lon),
                        Number(t.lat), Number(t.lon)) > LOCATION_RADIUS_M) continue;
    counts.set(t.categoryId, (counts.get(t.categoryId) || 0) + 1);
    total++;
  }
  if (!total) return empty;

  let bestId = null;
  let bestCount = 0;
  for (const [id, n] of counts) {
    if (n > bestCount) { bestCount = n; bestId = id; }
  }

  const share = bestCount / total;
  return {
    categoryId: bestId,
    samples: total,
    share: Math.round(share * 100) / 100,
    confident: total >= LOCATION_MIN_SAMPLES && share >= LOCATION_MIN_SHARE,
  };
}

/** 두 좌표 사이 거리(m). */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 가맹점명에서 브랜드로 쓸 만한 낱말을 고른다.
 *
 * 프랜차이즈는 지점명이 붙어 이름이 매번 달라진다. 짚이는 게 없으면 조용히
 * "이 이름 그대로"를 권한다 — 억지로 잘라내면 엉뚱한 곳까지 같이 분류된다.
 */
export function suggestKeyword(merchantRaw, { rules = [], transactions = [] } = {}) {
  const normalized = normalizeMerchant(merchantRaw);
  if (!normalized) return { scope: 'exact', keyword: '', reason: 'no-merchant' };

  const known = rules
    .filter((r) => r.matchType === 'contains' && r.pattern)
    .map((r) => String(r.pattern))
    .filter((p) => p.length >= 2 && normalized.includes(p))
    .sort((a, b) => b.length - a.length);       // 긴 쪽이 더 구체적이다
  if (known.length) return { scope: 'contains', keyword: known[0], reason: 'known-brand' };

  const prefix = sharedPrefix(normalized, transactions);
  if (prefix.length >= 3) return { scope: 'contains', keyword: prefix, reason: 'shared-prefix' };

  return { scope: 'exact', keyword: normalized, reason: 'no-clue' };
}

/** 과거 가맹점들과 겹치는 가장 긴 앞부분. 같은 이름은 세지 않는다. */
export function sharedPrefix(normalized, transactions = []) {
  let best = '';
  for (const t of transactions) {
    const other = normalizeMerchant(t.merchantRaw);
    if (!other || other === normalized) continue;
    let i = 0;
    while (i < other.length && i < normalized.length && other[i] === normalized[i]) i++;
    if (i > best.length) best = normalized.slice(0, i);
  }
  return best;
}
