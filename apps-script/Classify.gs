/**
 * 분류기. 위에서 걸리면 멈춘다.
 *
 *   1. Merchant.alwaysAsk       -> 무조건 물어봄
 *   2. Merchant.isPassthrough   -> 무조건 물어봄 (네이버페이 등 간편결제)
 *   3. Merchant.defaultCategory -> 확정
 *   4. Rule (learned)           -> 확정
 *   5. Rule (builtin, contains) -> 확정
 *   6. 실패                     -> 미분류. 알림으로 물어본다.
 */

function classify_(merchantRaw, amount) {
  const normalized = normalizeMerchant_(merchantRaw);
  if (!normalized) return { categoryId: null, reason: 'no-merchant' };

  const merchant = findBy_('Merchant', 'normalizedName', normalized);
  if (merchant) {
    if (merchant.alwaysAsk === true || merchant.alwaysAsk === 'TRUE') {
      return { categoryId: null, reason: 'always-ask', merchantId: merchant.id };
    }
    if (merchant.isPassthrough === true || merchant.isPassthrough === 'TRUE') {
      return { categoryId: null, reason: 'passthrough', merchantId: merchant.id };
    }
    if (merchant.defaultCategoryId) {
      return { categoryId: merchant.defaultCategoryId, reason: 'merchant-default', merchantId: merchant.id };
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
               merchantId: merchant ? merchant.id : null };
    }
  }

  return { categoryId: null, reason: 'no-match', merchantId: merchant ? merchant.id : null };
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
