/**
 * 원본 데이터 보기.
 *
 * 시트를 열어 눈으로 확인하던 일을 대신한다. 파서가 문자를 어떻게 읽었는지,
 * 어떤 규칙이 걸렸는지는 표로 봐야 빨리 안다.
 *
 * 복사 버튼이 핵심이다. 이 데이터를 남에게 보여 주려면 화면 밖으로 꺼낼 수
 * 있어야 하고, 그게 붙여넣기 한 번이어야 한다.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, collection, doc, getDocs, deleteDoc, query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const COLLECTIONS = [
  ['raw', '받은 문자', 'receivedAt'],
  ['txns', '거래', 'occurredAt'],
  ['rules', '분류 규칙', null],
  ['merchants', '가맹점', null],
  ['accounts', '계정', null],
  ['debts', '빚', null],
  ['recurring', '고정지출', null],
  ['settlements', '정산', null],
  ['anchors', '잔액 앵커', 'at'],
];

let db, uid, rows = [], current = COLLECTIONS[0];

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  el.setAttribute('role', 'status');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

async function load() {
  const [name, , sortField] = current;
  const base = collection(db, 'users', uid, name);
  const q = sortField ? query(base, orderBy(sortField, 'desc'), limit(200)) : query(base, limit(200));
  rows = (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}

function render() {
  const [name, label] = current;
  if (!rows.length) {
    $('out').innerHTML = `<div class="card"><div class="empty">${esc(label)}에 아직 아무것도 없어요.</div></div>`;
    return;
  }

  // 열은 실제로 값이 든 것만 보여 준다. 빈 칸으로 도배되면 읽을 수 없다.
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))]
    .filter((k) => rows.some((r) => r[k] !== null && r[k] !== undefined && r[k] !== ''));

  let h = `<div class="row" style="margin-bottom:10px">
    <span class="lbl grow">${esc(label)} · ${rows.length}건</span>
    <button type="button" class="act ghost" id="copyAll"
      style="min-height:36px;padding:8px 12px;font-size:12px">전체 복사</button></div>`;

  h += '<div class="card" style="overflow-x:auto;padding:12px"><table><thead><tr>';
  h += keys.map((k) => `<th>${esc(k)}</th>`).join('') + '<th></th></tr></thead><tbody>';

  rows.forEach((r, i) => {
    h += '<tr>' + keys.map((k) => `<td>${esc(format(r[k]))}</td>`).join('');
    h += `<td style="white-space:nowrap">
      <button type="button" class="act ghost" data-copy="${i}"
        style="min-height:30px;padding:5px 9px;font-size:11px">복사</button>
      <button type="button" class="act danger" data-del="${esc(r.id)}"
        style="margin-left:4px">삭제</button></td></tr>`;
  });

  h += '</tbody></table></div>';
  $('out').innerHTML = h;
}

function format(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.seconds !== undefined) return new Date(v.seconds * 1000).toISOString().slice(0, 19);
    return JSON.stringify(v);
  }
  return String(v);
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} 복사했어요`);
  } catch {
    // 사파리가 막으면 고를 수 있게 띄워 준다
    window.prompt('복사하세요 (Ctrl+C)', text);
  }
}

document.addEventListener('click', async (e) => {
  const one = e.target.closest('[data-copy]');
  if (one) return copy(JSON.stringify(rows[Number(one.dataset.copy)], null, 2), '한 줄');

  if (e.target.id === 'copyAll') {
    return copy(JSON.stringify(rows, null, 2), `${rows.length}건`);
  }

  const del = e.target.closest('[data-del]');
  if (del && confirm('지울까요? 되돌릴 수 없어요.')) {
    await deleteDoc(doc(db, 'users', uid, current[0], del.dataset.del));
    await load();
    toast('지웠어요');
  }
});

async function start() {
  const config = await fetch('/__/firebase/init.json').then((r) => r.json());
  const app = initializeApp(config);
  db = getFirestore(app);

  onAuthStateChanged(getAuth(app), async (user) => {
    if (!user) { location.href = '/'; return; }
    uid = user.uid;

    $('pick').innerHTML = COLLECTIONS
      .map(([n, label]) => `<option value="${n}">${esc(label)}</option>`).join('');
    $('pick').onchange = () => {
      current = COLLECTIONS.find(([n]) => n === $('pick').value);
      load();
    };

    $('boot').hidden = true;
    $('app').hidden = false;
    await load();
  });
}

start();
