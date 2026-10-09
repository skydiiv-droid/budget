/**
 * 내보내기.
 *
 * 언젠가 다른 데로 옮기거나 연말정산에 쓸 수 있어야 한다. 데이터가 이 앱
 * 안에만 있으면 앱이 인질을 잡고 있는 것이다.
 *
 * 엑셀이 한글을 깨뜨리지 않게 BOM 을 앞에 붙인다.
 */
import { splitParts, hasSplit } from './splits.js';

const BOM = '﻿';

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const HEADERS = [
  '날짜', '시각', '종류', '금액', '가게', '카테고리', '큰 갈래',
  '카드·계좌', '태그', '메모', '예산제외', '상태', '분할', '외화',
];

const KIND = { expense: '지출', income: '수입', transfer: '옮김', cancel: '취소' };

export function toCSV(transactions = [], { categories = [], accounts = [] } = {}) {
  const cat = (id) => categories.find((c) => c.id === id);
  const acc = (id) => accounts.find((a) => a.id === id)?.name ?? '';

  // 카테고리 여러 칸으로 나눠 둔 결제는 **조각마다 한 줄**로 내보낸다.
  // 그래야 표 계산기에서 카테고리로 묶었을 때 합이 맞는다. 금액 합은 그대로다.
  const rows = [...transactions]
    .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)))
    .flatMap((t) => {
      const parts = splitParts(t);
      const at = String(t.occurredAt || '');
      return parts.map((part, i) => {
        const c = cat(part.categoryId);
        const parent = c?.parentId ? cat(c.parentId) : null;
        return [
          at.slice(0, 10), at.slice(11, 16),
          KIND[t.type] || t.type || '',
          part.amount,
          t.merchantRaw || '',
          c?.name || '',
          parent?.name || (c && !c.parentId ? c.name : ''),
          acc(t.accountId) || t.cardName || '',
          (t.tags || []).join(' '),
          t.memo || '',
          t.excludeFromBudget ? 'Y' : '',
          t.status || '',
          hasSplit(t) ? `${i + 1}/${parts.length}` : '',
          // 해외 결제는 원금을 남긴다. 원화만 남기면 왜 그 금액인지 알 수 없다.
          t.fxCurrency && t.fxAmount ? `${t.fxCurrency} ${t.fxAmount}` : '',
        ].map(cell).join(',');
      });
    });

  return BOM + [HEADERS.join(','), ...rows].join('\r\n');
}
