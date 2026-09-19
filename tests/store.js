/**
 * Schema.gs의 시트 접근 함수를 메모리로 대체한다.
 * 정산 금액 계산처럼 여러 시트를 오가는 로직을 node에서 그대로 돌리기 위한 것.
 */
function createStore(initial = {}) {
  const tables = {};
  Object.keys(initial).forEach((name) => { tables[name] = initial[name].map((r) => ({ ...r })); });

  const table = (name) => (tables[name] = tables[name] || []);

  return {
    tables,
    readAll_: (name) => table(name).map((r) => ({ ...r })),
    append_: (name, obj) => { table(name).push({ ...obj }); return obj; },
    update_: (name, id, patch) => {
      const row = table(name).find((r) => r.id === id);
      if (!row) return false;
      Object.assign(row, patch);
      return true;
    },
    findBy_: (name, field, value) => {
      const row = table(name).find((r) => r[field] === value);
      return row ? { ...row } : null;
    },
  };
}

module.exports = { createStore };
