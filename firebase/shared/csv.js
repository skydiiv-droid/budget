/**
 * 내보내기.
 *
 * 언젠가 다른 데로 옮기거나 연말정산에 쓸 수 있어야 한다. 데이터가 이 앱
 * 안에만 있으면 앱이 인질을 잡고 있는 것이다.
 *
 * 엑셀이 한글을 깨뜨리지 않게 BOM 을 앞에 붙인다.
 */
const BOM = '﻿';

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const HEADERS = [
  '날짜', '시각', '종류', '금액', '가게', '카테고리', '큰 갈래',
  '카드·계좌', '태그', '메모', '예산제외', '상태',
];

const KIND = { expense: '지출', income: '수입', transfer: '옮김', cancel: '취소' };

export function toCSV(transactions = [], { categories = [], accounts = [] } = {}) {
  const cat = (id) => categories.find((c) => c.id === id);
  const acc = (id) => accounts.find((a) => a.id === id)?.name ?? '';

  const rows = [...transactions]
    .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)))
    .map((t) => {
      const c = cat(t.categoryId);
      const parent = c?.parentId ? cat(c.parentId) : null;
      const at = String(t.occurredAt || '');
      return [
        at.slice(0, 10), at.slice(11, 16),
        KIND[t.type] || t.type || '',
        Number(t.amount || 0),
        t.merchantRaw || '',
        c?.name || '',
        parent?.name || (c && !c.parentId ? c.name : ''),
        acc(t.accountId) || t.cardName || '',
        (t.tags || []).join(' '),
        t.memo || '',
        t.excludeFromBudget ? 'Y' : '',
        t.status || '',
      ].map(cell).join(',');
    });

  return BOM + [HEADERS.join(','), ...rows].join('\r\n');
}
