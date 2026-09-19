/**
 * 대시보드 페이지. 하나의 긴 글자이므로 손대는 일이 드물도록 따로 둔다.
 * __TOKEN__ 자리에 토큰이 들어간다.
 */
const DASHBOARD_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>가계부</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=Instrument+Serif&display=swap">
<style>
:root{
  --ground:#F7F5F0; --card:#FFF; --ink:#1A1917; --ink2:#57544E; --ink3:#6F6B63;
  --line:#E5E1D8; --line2:#F2EEE6;
  --debt:#B33A2B; --flow:#0A7B9C; --warn:#B07C1F;
  --warnbg:#FBF3E3; --warnline:#E8D9B8; --flowbg:#EAF4F7; --flowline:#C2DFE8;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font-family:"IBM Plex Sans KR",sans-serif;-webkit-font-smoothing:antialiased;
  padding-bottom:env(safe-area-inset-bottom)}
.wrap{max-width:460px;margin:0 auto;padding:18px 16px 92px}
h1{font-size:21px;font-weight:600;margin:0;letter-spacing:-.01em}
.sub{font-size:12px;color:var(--ink3)}
.tabs{position:fixed;left:0;right:0;bottom:0;z-index:5;display:flex;
  background:rgba(255,255,255,.96);border-top:1px solid var(--line);
  padding-bottom:env(safe-area-inset-bottom);backdrop-filter:blur(8px)}
.tabs button{flex:1;min-height:54px;font:inherit;font-size:12px;font-weight:500;
  background:none;color:var(--ink3);border:0;cursor:pointer;position:relative;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}
.tabs button[aria-current="page"]{color:var(--ink);font-weight:700}
.tabs button[aria-current="page"]::before{content:"";position:absolute;top:0;
  width:26px;height:2px;border-radius:0 0 2px 2px;background:var(--ink)}
.tabs .badge{position:absolute;top:8px;margin-left:30px;min-width:17px;height:17px;
  padding:0 4px;border-radius:9px;background:var(--debt);color:#fff;
  font-size:10.5px;font-weight:700;line-height:17px;text-align:center}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;
  padding:18px;margin-bottom:12px}
.row{display:flex;align-items:center;gap:10px}
.grow{flex-grow:1;min-width:0}
.big{font-family:"Instrument Serif",serif;line-height:1;letter-spacing:-.01em}
.num{font-variant-numeric:tabular-nums}
.bar{height:10px;border-radius:5px;background:#EFEAE0;overflow:hidden;display:flex}
.bar>i{border-radius:5px;display:block}
.lbl{font-size:12.5px;font-weight:600;color:var(--ink2)}
.muted{font-size:12px;color:var(--ink3)}
.hr{height:1px;background:var(--line2);margin:13px 0}
.note{border-radius:14px;padding:14px 15px;font-size:12.5px;line-height:1.6;margin-bottom:12px}
.note.warn{background:var(--warnbg);border:1px solid var(--warnline);color:#6B5518}
.note.ok{background:var(--flowbg);border:1px solid var(--flowline);color:#185E72}
.note b{font-weight:600}
.item{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line2)}
.item:last-child{border-bottom:0}
label{display:block;font-size:12.5px;font-weight:600;color:var(--ink2);margin-bottom:6px}
input,select{width:100%;font:inherit;font-size:15px;min-height:44px;padding:10px 12px;
  background:#fff;border:1px solid #DDD8CC;border-radius:10px;color:var(--ink)}
input:focus,select:focus{outline:2px solid var(--flow);outline-offset:-1px;border-color:var(--flow)}
.field{margin-bottom:12px}
.fields{display:flex;gap:10px}
.fields>.field{flex:1}
button.act{font:inherit;font-size:13.5px;font-weight:600;min-height:44px;padding:11px 16px;
  border-radius:10px;cursor:pointer;border:1px solid transparent}
button.primary{background:var(--ink);color:#fff}
button.ghost{background:#fff;color:var(--ink2);border-color:#DDD8CC}
button.danger{background:#FAEEEC;color:var(--debt);border-color:#EBD3CE;
  font-size:12px;padding:7px 11px;min-height:36px}
button.tiny{font-size:12px;padding:7px 11px;min-height:36px;background:#F2EEE6;
  color:var(--ink2);border-color:var(--line)}
.empty{text-align:center;padding:26px 16px;color:var(--ink3);font-size:13px;line-height:1.7}
.pill{font-size:11px;font-weight:600;padding:3px 7px;border-radius:6px;
  background:#FAEEEC;color:var(--debt)}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:9;
  background:var(--ink);color:#fff;font-size:13px;padding:11px 18px;border-radius:11px;
  box-shadow:0 6px 20px rgba(0,0,0,.18)}
</style>
</head>
<body>
<div class="wrap">
  <div class="row">
    <div class="grow"><h1>가계부</h1><div class="sub" id="monthLabel">불러오는 중</div></div>
  </div>

  <section id="home"><div class="card"><div class="empty">불러오는 중…</div></div></section>
  <section id="inbox" hidden></section>
  <section id="fixed" hidden></section>
  <section id="setup" hidden></section>
</div>

<nav class="tabs" aria-label="화면">
  <button type="button" data-tab="home" aria-current="page">홈</button>
  <button type="button" data-tab="inbox">인박스<span class="badge" id="badge" hidden>0</span></button>
  <button type="button" data-tab="fixed">고정</button>
  <button type="button" data-tab="setup">설정</button>
</nav>

<script>
/* 토큰은 URL에 두지 않는다. 주소가 길어지는 것보다, 방문 기록과 화면 캡처에
   남는 게 더 문제다. 한 번 넣으면 이 브라우저가 기억한다.
   ?token= 으로 들어오면 그것을 받아 저장하고, 다음부터는 주소만으로 열린다. */
var BOOT_TOKEN = '__TOKEN__';
var STORE_KEY = 'budget.token';
var TOKEN = '';
var D = null;

/* 마지막으로 본 값을 기억해 둔다. 서버는 아무리 빨라도 한두 번 왕복이 필요해서,
   그동안 빈 화면을 보여 주는 대신 지난번 화면을 먼저 그린다.
   새 값이 오면 조용히 바꾼다. */
var SNAP_KEY = 'budget.snapshot';

function saveSnapshot(d){
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(d)); } catch(e){}
}
function readSnapshot(){
  try { var raw = localStorage.getItem(SNAP_KEY); return raw ? JSON.parse(raw) : null; }
  catch(e){ return null; }
}
function dropSnapshot(){
  try { localStorage.removeItem(SNAP_KEY); } catch(e){}
}

function readStored(){
  try { return localStorage.getItem(STORE_KEY) || ''; } catch(e){ return ''; }
}
function storeToken(t){
  try { localStorage.setItem(STORE_KEY, t); } catch(e){}
}
function forgetToken(){
  try { localStorage.removeItem(STORE_KEY); } catch(e){}
  dropSnapshot();
}

var ASSET_LABEL = { checking: '입출금', savings: '저축 · 투자', cash: '현금' };

function won(n){ return Number(n||0).toLocaleString('ko-KR'); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function el(id){ return document.getElementById(id); }

function toast(msg){
  var t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; t.setAttribute('role','status');
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 2600);
}

function fail(err){ toast('실패: ' + (err && err.message ? err.message : err)); }

function showUnlock(msg){
  document.querySelector('.tabs').hidden = true;
  el('inbox').hidden = true; el('fixed').hidden = true; el('setup').hidden = true;
  el('home').hidden = false;
  el('monthLabel').textContent = '잠김';
  el('home').innerHTML =
    '<form class="card" id="unlockForm">'
    + '<div class="lbl" style="margin-bottom:12px">토큰을 넣어 주세요</div>'
    + (msg ? '<div class="note warn" style="margin-bottom:12px">' + esc(msg) + '</div>' : '')
    + '<div class="field"><label for="tk">INGEST_TOKEN</label>'
    + '<input id="tk" name="token" type="password" autocomplete="current-password" required></div>'
    + '<button type="submit" class="act primary" style="width:100%">열기</button>'
    + '<div class="muted" style="margin-top:10px">이 브라우저가 기억하므로 다음부터는 주소만으로 열립니다.</div>'
    + '</form>';
}

function unlocked(){
  document.querySelector('.tabs').hidden = false;
}

/* 처음 한 번. 어디서 토큰을 가져올지는 여기서만 정한다.
   load() 가 이 일을 같이 하면 방금 입력한 토큰을 덮어쓴다. */
function boot(){
  TOKEN = BOOT_TOKEN || readStored();
  if (!TOKEN) { showUnlock(''); return; }

  var snap = readSnapshot();
  if (snap){ unlocked(); render(snap); setStale(true); }
  load();
}

/* 지금 보고 있는 게 지난번 값이라는 표시. 숨기지 않는다 — 낡은 숫자를
   새 숫자인 양 보여 주는 건 숫자를 안 보여 주는 것보다 나쁘다. */
function setStale(on){
  var m = el('monthLabel');
  if (!m) return;
  if (on) m.textContent = m.textContent.replace(/ · 갱신 중…$/, '') + ' · 갱신 중…';
  else m.textContent = m.textContent.replace(/ · 갱신 중…$/, '');
}

function load(){
  if (!TOKEN) { showUnlock(''); return; }
  google.script.run
    .withSuccessHandler(function(d){
      storeToken(TOKEN); saveSnapshot(d); unlocked(); render(d); setStale(false);
    })
    .withFailureHandler(function(err){
      var m = String(err && err.message || err);
      if (m.indexOf('unauthorized') >= 0){
        forgetToken(); TOKEN = '';
        showUnlock('토큰이 맞지 않아요.');
      } else { fail(err); }
    })
    .apiLoad(TOKEN);
}

function call(fn, arg){
  setStale(true);
  google.script.run
    .withSuccessHandler(function(d){ saveSnapshot(d); render(d); setStale(false); toast('저장했어요'); })
    .withFailureHandler(function(err){ setStale(false); fail(err); })
    [fn](TOKEN, arg);
}

/* ───────── 홈 ───────── */
function renderHome(){
  var L = D.ledger, debt = L.debt, b = L.budget, p = L.planned;
  var h = '';

  if (!debt.total){
    h += '<div class="card"><div class="empty">아직 등록한 빚이 없어요.<br>'
      +  '설정에서 리볼빙·마이너스통장 잔액을 넣으면<br>여기에 남은 금액과 끝나는 시점이 나옵니다.</div></div>';
  } else {
    h += '<div class="card">'
      +  '<div class="row"><span class="lbl grow">남은 빚</span>'
      +  (debt.daysToTarget !== null
            ? '<span class="muted">목표까지 D-' + Math.max(0, debt.daysToTarget) + '</span>' : '')
      +  '</div>'
      +  '<div class="big num" style="font-size:42px;color:var(--debt);margin:10px 0 14px">₩' + won(debt.total) + '</div>'
      +  '<div class="bar"><i style="width:' + Math.min(100, debt.progressPct) + '%;background:var(--flow)"></i></div>'
      +  '<div class="row muted" style="margin-top:7px"><span class="grow">'
      +  '<b style="color:var(--flow)">' + debt.progressPct + '% 갚음</b> · 시작 ₩' + won(debt.startAmount)
      +  '</span></div><div class="hr"></div>';

    debt.items.forEach(function(d, i){
      h += '<div class="row" style="padding:7px 0">'
        +  '<span style="width:3px;height:26px;border-radius:2px;background:'
        +  (i === 0 ? 'var(--debt)' : '#C9C4B8') + '"></span>'
        +  '<span class="grow"><span style="font-size:13.5px;font-weight:600">' + esc(d.name) + '</span>'
        +  '<br><span class="muted">연 ' + (Number(d.rate)||0) + '%'
        +  (i === 0 && debt.items.length > 1 ? ' · 먼저 갚기' : '') + '</span></span>'
        +  '<span class="num" style="font-size:15px;font-weight:600">' + won(d.balance) + '</span></div>';
    });
    h += '</div>';

    if (!p.income){
      h += '<div class="note warn">월 실수령액을 아직 안 넣었어요. 설정에 넣으면 '
        +  '<b>언제 끝나는지</b>가 계산됩니다.</div>';
    } else if (debt.paceMonths === null){
      h += '<div class="note warn"><b>지금은 갚을 여력이 없어요.</b><br>'
        +  '고정지출이나 변동 예산을 줄이지 않으면 빚이 줄지 않습니다.</div>';
    } else if (debt.needPerMonth === null){
      h += '<div class="note ok">이 속도면 <b>' + debt.paceMonths + '개월</b> 걸려요. '
        +  '설정에서 목표 날짜를 정하면 속도가 맞는지 알려드릴게요.</div>';
    } else if (debt.onTrack){
      h += '<div class="note ok"><b>이 속도면 ' + debt.paceMonths + '개월 — 목표 안에 끝나요.</b><br>'
        +  '매달 ₩' + won(debt.needPerMonth) + ' 필요, 여력 ₩' + won(p.available) + '.</div>';
    } else {
      h += '<div class="note warn"><b>이 속도면 ' + debt.paceMonths + '개월 — 목표보다 늦어요.</b><br>'
        +  '목표 안에 끝내려면 매달 <b>₩' + won(debt.needPerMonth) + '</b>을 갚아야 해요. '
        +  '지금 여력은 <b>₩' + won(p.available) + '</b>, <b>₩' + won(debt.shortfall) + '</b> 모자랍니다.</div>';
    }
  }

  var A = L.assets || { items: [], total: 0, net: 0 };
  if (A.total || debt.total){
    h += '<div class="card"><div class="row"><span class="lbl grow">순자산</span>'
      +  '<span class="muted">가진 돈 − 빚</span></div>'
      +  '<div class="big num" style="font-size:30px;margin:9px 0 12px;color:'
      +  (A.net >= 0 ? 'var(--ink)' : 'var(--debt)') + '">'
      +  (A.net < 0 ? '−₩' + won(-A.net) : '₩' + won(A.net)) + '</div>';
    A.items.filter(function(a){ return a.balance; }).forEach(function(a){
      h += '<div class="row" style="padding:5px 0"><span class="grow" '
        +  'style="font-size:13px;color:var(--ink2)">' + esc(a.name) + '</span>'
        +  '<span class="num" style="font-size:13.5px;font-weight:600;color:var(--flow)">'
        +  won(a.balance) + '</span></div>';
    });
    if (debt.total){
      h += '<div class="row" style="padding:5px 0"><span class="grow" '
        +  'style="font-size:13px;color:var(--ink2)">빚</span>'
        +  '<span class="num" style="font-size:13.5px;font-weight:600;color:var(--debt)">− '
        +  won(debt.total) + '</span></div>';
    }
    h += '</div>';
  }

  h += '<div class="card"><div class="lbl" style="margin-bottom:11px">이번 달 계획</div>'
    +  flowRow('수입', p.income, 'var(--flow)', '+')
    +  flowRow('고정지출', p.fixed, 'var(--debt)', '−')
    +  flowRow('변동 예산', p.variableBudget, 'var(--debt)', '−')
    +  '<div class="hr"></div>'
    +  '<div class="row"><span class="grow" style="font-size:14px;font-weight:600">갚는 데 쓸 수 있는 돈</span>'
    +  '<span class="big num" style="font-size:22px;color:'
    +  (p.available >= 0 ? 'var(--flow)' : 'var(--debt)') + '">' + won(p.available) + '</span></div></div>';

  if (b.limit){
    h += '<div class="card"><div class="row"><span class="lbl grow">오늘 쓸 수 있는 돈</span>'
      +  '<span class="muted">남은 ' + b.daysLeft + '일</span></div>'
      +  '<div class="big num" style="font-size:32px;margin:9px 0 12px">₩' + won(b.perDay) + '</div>'
      +  '<div class="bar"><i style="width:' + Math.min(100, b.usedPct) + '%;background:var(--debt)"></i></div>'
      +  '<div class="muted" style="margin-top:7px">' + b.usedPct + '% 사용 · 쓴 돈 ₩' + won(b.spent)
      +  ' · 남은 ₩' + won(b.remaining) + '</div></div>';
  }

  if (L.inbox.pending || L.inbox.unparsed){
    h += '<button type="button" class="note warn" data-tab="inbox" style="width:100%;'
      +  'text-align:left;cursor:pointer;font:inherit;display:block">'
      +  '손이 필요한 것 — 분류 대기 <b>' + L.inbox.pending + '건</b>, '
      +  '해석 실패 문자 <b>' + L.inbox.unparsed + '건</b><br>'
      +  '<span style="text-decoration:underline">인박스에서 정리하기</span></button>';
  }
  el('home').innerHTML = h;
}

function flowRow(name, amount, color, sign){
  return '<div class="row" style="padding:5px 0"><span class="grow" style="font-size:13.5px;color:var(--ink2)">'
    + name + '</span><span class="num" style="font-size:13.5px;font-weight:600;color:' + color + '">'
    + sign + ' ' + won(amount) + '</span></div>';
}

/* ───────── 인박스 ───────── */
function renderInbox(){
  var h = '';
  var P = D.pending || [], U = D.unparsed || [];

  if (!P.length && !U.length){
    h = '<div class="card"><div class="empty">정리할 게 없어요.<br>'
      + '분류하지 못한 결제가 생기면 여기에 쌓입니다.</div></div>';
    el('inbox').innerHTML = h;
    return;
  }

  if (P.length){
    h += '<div class="lbl" style="margin:2px 0 9px">분류가 필요해요 · ' + P.length + '건</div>';
    P.forEach(function(t){
      h += '<div class="card" data-txn="' + esc(t.id) + '">'
        +  '<div class="row" style="align-items:flex-start">'
        +  '<span class="grow"><span style="font-size:15px;font-weight:600">' + esc(t.merchant) + '</span>'
        +  '<br><span class="muted">' + esc(String(t.occurredAt).replace('T',' ').slice(5,16))
        +  (t.account ? ' · ' + esc(t.account) : '') + '</span></span>'
        +  '<span class="big num" style="font-size:22px">' + won(t.amount) + '</span></div>';

      if (t.nearbyNote){
        h += '<div class="note ok" style="margin:12px 0 0;padding:9px 12px">'
          +  esc(t.nearbyNote) + ' 왔던 곳이에요</div>';
      }

      h += '<div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:13px">';
      t.suggestions.forEach(function(c, i){
        h += '<button type="button" class="act ' + (i === 0 ? 'primary' : 'ghost')
          +  '" data-pick="' + esc(t.id) + '" data-cat="' + esc(c.id) + '">'
          +  esc(c.name) + '</button>';
      });
      h += '</div>';

      h += '<div class="hr"></div><div class="fields">'
        +  '<div class="field" style="margin:0"><label>그 밖의 카테고리</label>'
        +  '<select data-other="' + esc(t.id) + '"><option value="">고르기…</option>'
        +  D.categories.map(function(c){
              return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('')
        +  '</select></div>'
        +  '<div class="field" style="margin:0"><label>앞으로</label>'
        +  '<select data-scope="' + esc(t.id) + '">'
        +  t.scopeOptions.map(function(o){
              return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('')
        +  '</select></div></div></div>';
    });
  }

  if (U.length){
    h += '<div class="lbl" style="margin:18px 0 9px">해석하지 못한 문자 · ' + U.length + '건</div>';
    U.forEach(function(r){
      h += '<form class="card" data-raw="' + esc(r.id) + '">'
        +  '<div style="background:var(--ground);border-radius:9px;padding:10px 12px;'
        +  'font-size:11.5px;color:var(--ink2);line-height:1.6;white-space:pre-line">'
        +  esc(r.body) + '</div>'
        +  (r.note ? '<div class="muted" style="margin-top:8px">' + esc(r.note) + '</div>' : '')
        +  '<div class="fields" style="margin-top:12px">'
        +  '<div class="field" style="margin:0"><label>금액</label>'
        +  '<input name="amount" inputmode="numeric" placeholder="9,900"></div>'
        +  '<div class="field" style="margin:0"><label>가맹점</label>'
        +  '<input name="merchant" placeholder="어디서 썼나요"></div></div>'
        +  '<div class="field"><label>카테고리</label><select name="categoryId">'
        +  '<option value="">고르지 않음</option>'
        +  D.categories.map(function(c){
              return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('')
        +  '</select></div>'
        +  '<div style="display:flex;gap:7px">'
        +  '<button type="submit" class="act primary" style="flex:1">거래로 넣기</button>'
        +  '<button type="button" class="act ghost" data-ignore="' + esc(r.id) + '">거래 아님</button>'
        +  '</div></form>';
    });
  }

  el('inbox').innerHTML = h;
}

function pickCategory(txnId, categoryId){
  var scopeSel = document.querySelector('[data-scope="' + txnId + '"]');
  call('apiCategorize', {
    txnId: txnId,
    choice: categoryId,
    scopeChoice: scopeSel ? scopeSel.value : '',
  });
}

/* ───────── 고정지출 ───────── */
function renderFixed(){
  var list = D.recurring;
  var total = list.reduce(function(s, r){ return s + Number(r.expectedAmount || 0); }, 0);
  var h = '<div class="card"><div class="lbl">매달 빠져나가는 돈</div>'
    + '<div class="big num" style="font-size:34px;margin:9px 0 6px">₩' + won(total) + '</div>'
    + '<div class="muted">1년이면 <b style="color:var(--debt)">₩' + won(total * 12) + '</b></div></div>';

  h += '<div class="card">';
  if (!list.length){
    h += '<div class="empty">등록한 고정지출이 없어요.<br>구독·통신비·보험료를 넣으면'
      +  '<br>갚을 여력이 정확해집니다.</div>';
  } else {
    list.forEach(function(r){
      h += '<div class="item"><span class="muted num" style="width:34px">'
        +  (r.dayOfMonth ? r.dayOfMonth + '일' : '—') + '</span>'
        +  '<span class="grow" style="font-size:13.5px;font-weight:500">' + esc(r.name) + '</span>'
        +  '<span class="num" style="font-size:13.5px;font-weight:600">' + won(r.expectedAmount) + '</span>'
        +  '<button type="button" class="act danger" data-del-rec="' + esc(r.id) + '">삭제</button></div>';
    });
  }
  h += '</div>';

  h += '<form class="card" id="recForm"><div class="lbl" style="margin-bottom:12px">고정지출 추가</div>'
    + '<div class="field"><label for="recName">이름</label>'
    + '<input id="recName" name="name" placeholder="넷플릭스" required></div>'
    + '<div class="fields"><div class="field"><label for="recAmt">금액</label>'
    + '<input id="recAmt" name="expectedAmount" inputmode="numeric" placeholder="17,000" required></div>'
    + '<div class="field"><label for="recDay">결제일</label>'
    + '<input id="recDay" name="dayOfMonth" inputmode="numeric" placeholder="5"></div></div>'
    + '<div class="field"><label for="recCat">카테고리</label><select id="recCat" name="categoryId">'
    + '<option value="">고르지 않음</option>'
    + D.categories.map(function(c){
        return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('')
    + '</select></div>'
    + '<button type="submit" class="act primary" style="width:100%">추가</button></form>';

  el('fixed').innerHTML = h;
}

/* ───────── 설정 ───────── */
function renderSetup(){
  var s = D.settings;
  var h = '<form class="card" id="setForm"><div class="lbl" style="margin-bottom:12px">돈의 흐름</div>'
    + '<div class="field"><label for="inc">월 실수령액</label>'
    + '<input id="inc" name="monthlyIncome" inputmode="numeric" value="' + won(s.monthlyIncome) + '"></div>'
    + '<div class="field"><label for="vb">변동지출 예산</label>'
    + '<input id="vb" name="variableBudget" inputmode="numeric" value="' + won(s.variableBudget) + '">'
    + '<div class="muted" style="margin-top:6px">고정지출 말고 쓰는 돈. 감으로 잡고 나중에 고쳐도 됩니다.</div></div>'
    + '<div class="hr"></div>'
    + '<div class="fields"><div class="field"><label for="ds">빚 시작 금액</label>'
    + '<input id="ds" name="debtStartAmount" inputmode="numeric" value="' + won(s.debtStartAmount) + '"></div>'
    + '<div class="field"><label for="dt">목표 완료일</label>'
    + '<input id="dt" name="debtTargetDate" type="date" value="' + esc(s.debtTargetDate) + '"></div></div>'
    + '<div class="muted" style="margin:-4px 0 12px">시작 금액은 진행률의 기준점이에요. 비우면 지금 잔액이 기준이 됩니다.</div>'
    + '<button type="submit" class="act primary" style="width:100%">저장</button></form>';

  h += '<div class="card"><div class="lbl" style="margin-bottom:6px">빚</div>';
  if (!D.debts.length){
    h += '<div class="empty">아직 없어요.</div>';
  } else {
    D.debts.forEach(function(d){
      h += '<div class="item"><span class="grow">'
        +  '<span style="font-size:13.5px;font-weight:600">' + esc(d.name) + '</span>'
        +  '<br><span class="muted">연 ' + (Number(d.rate) || 0) + '%'
        +  (d.billingDay ? ' · 매월 ' + d.billingDay + '일' : '') + '</span></span>'
        +  '<span class="num" style="font-size:14px;font-weight:600">' + won(d.balance) + '</span>'
        +  '<button type="button" class="act danger" data-del-debt="' + esc(d.id) + '">삭제</button></div>';
    });
  }
  h += '</div>';

  h += '<form class="card" id="debtForm"><div class="lbl" style="margin-bottom:12px">빚 추가 · 잔액 고치기</div>'
    + '<div class="muted" style="margin:-6px 0 12px">같은 이름으로 다시 넣으면 잔액이 바뀝니다.</div>'
    + '<div class="field"><label for="dName">이름</label>'
    + '<input id="dName" name="name" placeholder="리볼빙" required></div>'
    + '<div class="fields"><div class="field"><label for="dBal">잔액</label>'
    + '<input id="dBal" name="balance" inputmode="numeric" placeholder="1,840,000" required></div>'
    + '<div class="field"><label for="dRate">연 이자율 %</label>'
    + '<input id="dRate" name="rate" inputmode="decimal" placeholder="17.9"></div></div>'
    + '<div class="field"><label for="dDay">결제일</label>'
    + '<input id="dDay" name="billingDay" inputmode="numeric" placeholder="5"></div>'
    + '<button type="submit" class="act primary" style="width:100%">저장</button>'
    + '<div class="muted" style="margin-top:10px">이자율을 넣으면 비싼 빚부터 갚으라고 홈에서 알려줍니다.</div></form>';

  var assets = (D.accounts || []).filter(function(a){ return a.type !== 'card'; });
  h += '<div class="card"><div class="lbl" style="margin-bottom:6px">가진 돈</div>'
    + '<div class="muted" style="margin-bottom:10px">통장 잔고는 입출금 문자가 올 때마다 '
    + '알아서 맞춰집니다. 저축·투자는 직접 넣어 주세요.</div>';
  if (!assets.length){
    h += '<div class="empty">아직 없어요.</div>';
  } else {
    assets.forEach(function(a){
      h += '<div class="item"><span class="grow">'
        +  '<span style="font-size:13.5px;font-weight:600">' + esc(a.name) + '</span>'
        +  '<br><span class="muted">' + esc(ASSET_LABEL[a.type] || a.type)
        +  (a.balanceAt ? ' · ' + esc(String(a.balanceAt).slice(5,10)) + ' 기준' : '') + '</span></span>'
        +  '<span class="num" style="font-size:14px;font-weight:600">' + won(a.balance) + '</span>'
        +  '<button type="button" class="act danger" data-del-acc="' + esc(a.id) + '">삭제</button></div>';
    });
  }
  h += '</div>';

  h += '<form class="card" id="accForm"><div class="lbl" style="margin-bottom:12px">가진 돈 추가 · 고치기</div>'
    + '<div class="muted" style="margin:-6px 0 12px">같은 이름으로 다시 넣으면 잔액이 바뀝니다.</div>'
    + '<div class="field"><label for="aName">이름</label>'
    + '<input id="aName" name="name" placeholder="우리은행 · 청약 · 적금" required></div>'
    + '<div class="fields"><div class="field"><label for="aBal">잔액</label>'
    + '<input id="aBal" name="balance" inputmode="numeric" placeholder="500,000" required></div>'
    + '<div class="field"><label for="aType">종류</label><select id="aType" name="type">'
    + '<option value="checking">입출금</option>'
    + '<option value="savings">저축 · 투자</option>'
    + '<option value="cash">현금</option>'
    + '</select></div></div>'
    + '<button type="submit" class="act primary" style="width:100%">저장</button></form>';

  h += '<form class="card" id="tokenForm"><div class="lbl" style="margin-bottom:6px">토큰 바꾸기</div>'
    + '<div class="muted" style="margin-bottom:12px">외우기 쉬운 문장으로 바꿔도 됩니다. '
    + '8자 이상, 공백과 <b>&amp; ? # % + /</b> 는 쓸 수 없어요.</div>'
    + '<div class="field"><label for="nt1">새 토큰</label>'
    + '<input id="nt1" name="newToken" type="password" autocomplete="new-password" required></div>'
    + '<div class="field"><label for="nt2">한 번 더</label>'
    + '<input id="nt2" name="confirm" type="password" autocomplete="new-password" required></div>'
    + '<button type="submit" class="act primary" style="width:100%">바꾸기</button>'
    + '<div class="note warn" style="margin:12px 0 0">바꾸면 <b>아이폰 단축어의 token 값도</b> '
    + '같이 고쳐야 해요. 안 고치면 문자가 안 들어옵니다.</div></form>';

  h += '<div class="card"><div class="lbl" style="margin-bottom:6px">이 기기</div>'
    + '<div class="muted" style="margin-bottom:12px">토큰을 이 브라우저가 기억하고 있어요. '
    + '남의 기기에서 열었다면 지우고 나가세요.</div>'
    + '<button type="button" class="act ghost" id="lockBtn" style="width:100%">기억한 토큰 지우기</button></div>';

  el('setup').innerHTML = h;
}

/* ───────── 묶기 ───────── */
function formData(form){
  var out = {};
  Array.prototype.forEach.call(form.elements, function(f){
    if (f.name) out[f.name] = f.value;
  });
  return out;
}

function render(data){
  D = data;
  el('monthLabel').textContent = D.ledger.month + ' · 1일 ~ 말일';
  var waiting = (D.pending || []).length + (D.unparsed || []).length;
  var badge = el('badge');
  badge.hidden = !waiting;
  badge.textContent = waiting > 99 ? '99+' : waiting;
  renderHome(); renderInbox(); renderFixed(); renderSetup();
}

function showTab(name){
  ['home','inbox','fixed','setup'].forEach(function(id){ el(id).hidden = (id !== name); });
  document.querySelectorAll('.tabs [data-tab]').forEach(function(b){
    if (b.dataset.tab === name) b.setAttribute('aria-current','page');
    else b.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
}

document.addEventListener('click', function(e){
  var tab = e.target.closest('[data-tab]');
  if (tab){ showTab(tab.dataset.tab); return; }

  var pick = e.target.closest('[data-pick]');
  if (pick){ pickCategory(pick.dataset.pick, pick.dataset.cat); return; }

  var ig = e.target.closest('[data-ignore]');
  if (ig){ call('apiIgnoreRaw', ig.dataset.ignore); return; }
  if (e.target.id === 'lockBtn'){
    forgetToken(); TOKEN = '';
    showUnlock('토큰을 지웠어요.');
    return;
  }
  var da = e.target.closest('[data-del-acc]');
  if (da && confirm('지울까요?')) { call('apiDeleteAccount', da.dataset.delAcc); return; }
  var dd = e.target.closest('[data-del-debt]');
  if (dd && confirm('지울까요?')) { call('apiDeleteDebt', dd.dataset.delDebt); return; }
  var dr = e.target.closest('[data-del-rec]');
  if (dr && confirm('지울까요?')) { call('apiDeleteRecurring', dr.dataset.delRec); return; }
});

document.addEventListener('change', function(e){
  var other = e.target.closest('[data-other]');
  if (other && other.value) pickCategory(other.dataset.other, other.value);
});

document.addEventListener('submit', function(e){
  e.preventDefault();
  var f = e.target;
  if (f.dataset.raw){
    var d = formData(f); d.rawId = f.dataset.raw;
    call('apiManualFromRaw', d);
    return;
  }
  if (f.id === 'unlockForm'){
    TOKEN = f.elements.token.value.trim();
    if (TOKEN) load();
    return;
  }
  if (f.id === 'tokenForm'){
    var a = f.elements.newToken.value.trim();
    var b = f.elements.confirm.value.trim();
    if (a !== b) { toast('두 칸이 서로 달라요'); return; }
    google.script.run
      .withSuccessHandler(function(){
        TOKEN = a; storeToken(a); f.reset();
        toast('바꿨어요 — 단축어의 token 도 고쳐 주세요');
      })
      .withFailureHandler(fail)
      .apiChangeToken(TOKEN, a);
    return;
  }
  if (f.id === 'setForm') call('apiSaveSettings', formData(f));
  else if (f.id === 'debtForm') call('apiSaveDebt', formData(f));
  else if (f.id === 'accForm') call('apiSaveAccount', formData(f));
  else if (f.id === 'recForm') call('apiSaveRecurring', formData(f));
});

boot();
</script>
</body>
</html>`;
