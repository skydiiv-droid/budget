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

/**
 * 내보낸 CSV 를 다시 읽는다.
 *
 * 내보내기만 있고 들이는 길이 없었다. 기기를 바꾸거나 계정이 꼬이면 되돌릴
 * 길이 그 파일 하나인데, 그걸 다시 넣을 데가 없으면 파일은 **종이 쪼가리**다.
 *
 * 머리글 이름으로 칸을 찾는다. 자리로 찾으면 칸이 하나 늘어난 판에서 전부
 * 어긋난다 — 실제로 「분할」과 「외화」를 뒤에 더했다.
 *
 * 나눠 둔 거래는 조각마다 한 줄로 나갔다. 같은 날 · 같은 시각 · 같은 가맹점 ·
 * 같은 카드면 한 거래로 되묶는다. 안 묶으면 거래가 둘로 늘어나고 카드사
 * 누적 대조에 없던 빵꾸가 생긴다.
 */
/**
 * CSV 한 줄을 칸으로 가른다. 따옴표 안의 쉼표는 칸 구분이 아니다.
 *
 * 정규식으로 훑다가 길이 0 짜리 일치에 걸려 무한 루프에 빠졌다 — 쉼표로
 * 시작하는 줄에서. 한 글자씩 읽는 쪽이 짧고 걸릴 데가 없다.
 */
export function splitRow(line) {
  const text = String(line ?? '');
  const out = [];
  let cur = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') { cur += ch; continue; }
      if (text[i + 1] === '"') { cur += '"'; i++; continue; }   // "" 는 따옴표 한 개
      quoted = false;
      continue;
    }
    if (ch === '"' && !cur.trim()) { quoted = true; continue; }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const KIND_BACK = { 지출: 'expense', 수입: 'income', 옮김: 'transfer', 이체: 'transfer', 취소: 'cancel' };
const money = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/**
 * @returns {{ rows, skipped, note }} rows 는 거래 모양, skipped 는 못 읽은 줄 수
 */
export function fromCSV(text, { categories = [], accounts = [] } = {}) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], skipped: 0, note: '빈 파일입니다' };

  const head = splitRow(lines[0]);
  const at = (name) => head.indexOf(name);
  const col = { day: at('날짜'), time: at('시각'), kind: at('종류'), amount: at('금액'),
                merchant: at('가게'), cat: at('카테고리'), account: at('카드·계좌'),
                tags: at('태그'), memo: at('메모'), skip: at('예산제외'),
                status: at('상태'), split: at('분할'), fx: at('외화') };
  if (col.day < 0 || col.amount < 0) {
    return { rows: [], skipped: lines.length - 1, note: '머리글에 날짜·금액 칸이 없습니다' };
  }

  // 이름으로 id 를 되찾는다. 못 찾으면 비워 둔다 — 없는 칸을 가리키면 안 된다.
  const catId = (name) => categories.find((c) => c.name === name)?.id || '';
  const accId = (name) => accounts.find((a) => a.name === name)?.id || '';

  const byKey = new Map();
  let skipped = 0;

  for (const line of lines.slice(1)) {
    const c = splitRow(line);
    const day = String(c[col.day] || '').slice(0, 10);
    const amount = money(c[col.amount]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !amount) { skipped++; continue; }

    const time = /^\d{2}:\d{2}/.test(String(c[col.time] || '')) ? c[col.time].slice(0, 5) : '12:00';
    const merchant = col.merchant >= 0 ? String(c[col.merchant] || '') : '';
    const account = col.account >= 0 ? String(c[col.account] || '') : '';
    const key = `${day}T${time}|${merchant}|${account}`;
    const cat = col.cat >= 0 ? catId(c[col.cat]) : '';

    const got = byKey.get(key);
    if (got) {
      // 같은 거래의 다른 조각이다. 금액을 더하고 카테고리는 조각으로 남긴다.
      got.amount += amount;
      if (cat) got.splits.push({ categoryId: cat, amount });
      continue;
    }

    const fx = col.fx >= 0 ? String(c[col.fx] || '').trim().split(/\s+/) : [];
    byKey.set(key, {
      occurredAt: `${day}T${time}:00`,
      type: KIND_BACK[c[col.kind]] || 'expense',
      amount,
      currency: 'KRW',
      merchantRaw: merchant,
      categoryId: cat,
      accountId: accId(account),
      cardName: accId(account) ? '' : account,
      tags: col.tags >= 0 ? String(c[col.tags] || '').split(/\s+/).filter(Boolean) : [],
      memo: col.memo >= 0 ? String(c[col.memo] || '') : '',
      excludeFromBudget: col.skip >= 0 && String(c[col.skip] || '').toUpperCase() === 'Y',
      status: col.status >= 0 && c[col.status] ? String(c[col.status]) : 'confirmed',
      fxCurrency: fx.length === 2 ? fx[0] : '',
      fxAmount: fx.length === 2 ? Number(fx[1]) || 0 : 0,
      splits: cat ? [{ categoryId: cat, amount }] : [],
    });
  }

  // 조각이 하나뿐이면 나눈 것이 아니다. 그릇을 비워 둔다.
  const rows = [...byKey.values()].map((r) => {
    const split = r.splits.length > 1;
    return { ...r,
      // 되묶었으면 대표 카테고리는 가장 큰 조각으로 둔다
      categoryId: split
        ? [...r.splits].sort((a, b) => b.amount - a.amount)[0].categoryId
        : r.categoryId,
      splits: split ? r.splits : [] };
  });

  return { rows, skipped, note: '' };
}

/**
 * 이미 있는 거래인가.
 *
 * CSV 에는 id 가 없다. 날짜 · 금액 · 가맹점이 같으면 같은 건으로 본다 —
 * 두 번 들이면 지출이 두 배가 되고, 그걸 되돌릴 방법은 하나하나 지우는 것뿐이다.
 */
export const csvKey = (t) => [String(t.occurredAt || '').slice(0, 16),
                              Math.round(Number(t.amount || 0)),
                              String(t.merchantRaw || '').trim()].join('|');
