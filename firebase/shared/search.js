/**
 * 찾기.
 *
 * "그때 그 병원 얼마 냈더라"를 풀려면 이름을 정확히 몰라도 찾아져야 한다.
 * 가게 이름은 지점명이 붙어 매번 다르고(컴포즈커피발산 / 컴포즈커피등촌),
 * 기억나는 건 보통 앞 두어 글자다. 그래서 부분 일치로만 찾는다.
 *
 * 가게 이름 · 메모 · 태그 · 카테고리 이름 · 카드 이름 · 금액을 한꺼번에 훑는다.
 * 어디에 적어 뒀는지까지 기억해야 한다면 찾기가 아니다.
 */
import { normalizeMerchant } from './parse.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');
const digits = (s) => String(s ?? '').replace(/[^\d]/g, '');

/** 검색어를 낱말로 쪼갠다. 모두 들어맞아야 한다 — 좁힐수록 쓸모 있다. */
export const terms = (query) =>
  String(query || '').trim().split(/\s+/).filter(Boolean).map(norm);

/**
 * @param {string} query
 * @param {object} data { transactions, categories, tags }
 * @returns 맞은 거래들. 최근 것부터.
 */
export function search(query, data = {}) {
  const words = terms(query);
  if (!words.length) return [];
  const { transactions = [], categories = [] } = data;
  const name = (id) => categories.find((c) => c.id === id)?.name ?? '';

  return transactions
    .filter((t) => t.type !== 'cancel')
    .filter((t) => {
      const hay = [
        t.merchantRaw, normalizeMerchant(t.merchantRaw), t.memo,
        ...(t.tags || []), name(t.categoryId), t.cardName,
        String(t.occurredAt || '').slice(0, 10),
      ].map(norm).join('|');
      const num = digits(t.amount);

      return words.every((w) => {
        if (hay.includes(w)) return true;
        // 숫자만 친 건 금액을 찾는 것이다. 12000 도 12,000 도 같은 돈이다.
        const d = digits(w);
        return d.length >= 2 && num.includes(d);
      });
    })
    .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
}

/** 쓴 적 있는 태그를 많이 쓴 순으로. 새로 칠 때 골라 쓰라고. */
export function knownTags(transactions = []) {
  const count = new Map();
  for (const t of transactions) {
    for (const tag of t.tags || []) {
      const key = String(tag).trim();
      if (key) count.set(key, (count.get(key) || 0) + 1);
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => ({ name, count: n }));
}

/** 쉼표로 친 태그를 정리한다. 같은 걸 두 번 넣지 않는다. */
export function parseTags(text) {
  const seen = new Set();
  return String(text || '')
    .split(/[,\n]/).map((s) => s.trim().replace(/^#/, ''))
    .filter((s) => s && s.length <= 20)
    .filter((s) => (seen.has(s) ? false : seen.add(s)))
    .slice(0, 8);
}
