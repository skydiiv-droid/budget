/**
 * 아이폰 단축어에 그대로 띄울 메뉴를 서버가 만들어 준다.
 *
 * 단축어에서 JSON 배열을 다루는 건 번거롭다. 사전에서 값 꺼내고, 반복하고,
 * id를 따로 들고 다녀야 한다. 그래서 여기서 **줄바꿈으로 이어붙인 글자**를
 * 만들어 보낸다. 단축어는 이렇게만 하면 된다.
 *
 *   텍스트 나누기(줄바꿈) -> 목록에서 선택 -> 고른 글자를 그대로 되돌려주기
 *
 * 되돌아온 글자는 서버가 알아서 해석한다. 단축어는 id를 몰라도 된다.
 */

/** 카테고리 메뉴. 짚이는 것 몇 개를 앞에 둔다. */
function categoryMenuText_(decision) {
  const categories = readAll_('Category').filter(function (c) { return c.kind === 'expense'; });
  const suggested = suggestionsFor_(decision).map(function (c) { return c.id; });

  const order = function (c) {
    const rank = suggested.indexOf(c.id);
    return rank >= 0 ? rank : 100 + (Number(c.sortOrder) || 0);
  };

  return categories
    .sort(function (a, b) { return order(a) - order(b); })
    .map(function (c) { return (c.icon ? c.icon + ' ' : '') + c.name; })
    .join('\n');
}

/**
 * 규칙 범위 메뉴.
 *
 *   모두: 컴포즈            -> 그 낱말이 들어간 모든 가맹점
 *   이 가게만: 컴포즈커피발산 -> 이름이 똑같은 곳만
 *   이번만                  -> 규칙을 만들지 않음
 *
 * 앞머리로 구분하므로 되돌아온 글자를 그대로 해석할 수 있다.
 */
function scopeMenuText_(merchantRaw) {
  const hint = suggestKeyword_(merchantRaw);
  const normalized = normalizeMerchant_(merchantRaw);
  const lines = [];

  if (hint.scope === 'contains' && hint.keyword && hint.keyword !== normalized) {
    lines.push('모두: ' + hint.keyword);
  }
  if (normalized) lines.push('이 가게만: ' + normalized);
  lines.push('이번만');
  return lines.join('\n');
}

/** 메뉴에서 고른 글자를 카테고리로 되돌린다. "☕ 카페" -> cat_cafe */
function resolveCategory_(choice) {
  const text = String(choice || '').trim();
  if (!text) return null;

  const categories = readAll_('Category');

  const byId = categories.filter(function (c) { return c.id === text; })[0];
  if (byId) return byId.id;

  // 아이콘이 앞에 붙어 오므로 이름이 들어 있는지로 찾는다.
  // 짧은 이름이 긴 이름에 걸리지 않게 긴 쪽부터 본다 ("구독" vs "구독디지털").
  const matched = categories
    .filter(function (c) { return c.name && text.indexOf(c.name) >= 0; })
    .sort(function (a, b) { return b.name.length - a.name.length; })[0];

  return matched ? matched.id : null;
}

/** 범위 메뉴에서 고른 글자를 해석한다. */
function parseScopeChoice_(choice, merchantRaw) {
  const text = String(choice || '').trim();

  if (text.indexOf('모두:') === 0) {
    return { scope: 'contains', keyword: text.slice(3).trim() };
  }
  if (text.indexOf('이 가게만') === 0) {
    return { scope: 'exact', keyword: normalizeMerchant_(merchantRaw) };
  }
  if (text.indexOf('이번만') === 0) {
    return { scope: 'once', keyword: '' };
  }

  // 아무것도 안 고르고 넘어오면 서버가 권하는 범위를 쓴다
  const hint = suggestKeyword_(merchantRaw);
  return { scope: hint.scope, keyword: hint.keyword };
}

/** 알림에 그대로 띄울 한 줄. */
function confirmMessage_(categoryId, learned, alsoFixed) {
  const category = findBy_('Category', 'id', categoryId);
  const name = category ? category.name : categoryId;
  const parts = [name + '(으)로 저장'];

  if (learned.scope === 'contains' && learned.keyword) {
    parts.push('앞으로 「' + learned.keyword + '」는 자동');
  } else if (learned.scope === 'exact' && learned.keyword) {
    parts.push('앞으로 이 가게는 자동');
  }
  if (alsoFixed) parts.push('밀려 있던 ' + alsoFixed + '건도 정리');

  return parts.join(' · ');
}
