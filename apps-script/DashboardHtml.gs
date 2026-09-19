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
.wrap{max-width:460px;margin:0 auto;padding:18px 16px 40px}
h1{font-size:21px;font-weight:600;margin:0;letter-spacing:-.01em}
.sub{font-size:12px;color:var(--ink3)}
.tabs{display:flex;gap:6px;margin:14px 0 16px}
.tabs button{flex:1;min-height:44px;font:inherit;font-size:13.5px;font-weight:500;
  background:var(--card);color:var(--ink2);border:1px solid var(--line);
  border-radius:11px;cursor:pointer}
.tabs button[aria-current="page"]{background:var(--ink);color:#fff;border-color:var(--ink);font-weight:600}
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

  <nav class="tabs" aria-label="화면">
    <button type="button" data-tab="home" aria-current="page">홈</button>
    <button type="button" data-tab="fixed">고정지출</button>
    <button type="button" data-tab="setup">설정</button>
  </nav>

  <section id="home"></section>
  <section id="fixed" hidden></section>
  <section id="setup" hidden></section>
</div>

<script>
var TOKEN = '__TOKEN__';
var D = null;

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

function load(){
  google.script.run.withSuccessHandler(render).withFailureHandler(fail).apiLoad(TOKEN);
}

function call(fn, arg){
  google.script.run.withSuccessHandler(function(d){ render(d); toast('저장했어요'); })
    .withFailureHandler(fail)[fn](TOKEN, arg);
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
    h += '<div class="note warn">손이 필요한 것 — 분류 대기 <b>' + L.inbox.pending
      +  '건</b>, 해석 실패 문자 <b>' + L.inbox.unparsed + '건</b></div>';
  }
  el('home').innerHTML = h;
}

function flowRow(name, amount, color, sign){
  return '<div class="row" style="padding:5px 0"><span class="grow" style="font-size:13.5px;color:var(--ink2)">'
    + name + '</span><span class="num" style="font-size:13.5px;font-weight:600;color:' + color + '">'
    + sign + ' ' + won(amount) + '</span></div>';
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
  renderHome(); renderFixed(); renderSetup();
}

document.addEventListener('click', function(e){
  var tab = e.target.closest('[data-tab]');
  if (tab){
    ['home','fixed','setup'].forEach(function(id){ el(id).hidden = (id !== tab.dataset.tab); });
    document.querySelectorAll('[data-tab]').forEach(function(b){
      if (b === tab) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
    });
    return;
  }
  var dd = e.target.closest('[data-del-debt]');
  if (dd && confirm('지울까요?')) { call('apiDeleteDebt', dd.dataset.delDebt); return; }
  var dr = e.target.closest('[data-del-rec]');
  if (dr && confirm('지울까요?')) { call('apiDeleteRecurring', dr.dataset.delRec); return; }
});

document.addEventListener('submit', function(e){
  e.preventDefault();
  var f = e.target;
  if (f.id === 'setForm') call('apiSaveSettings', formData(f));
  else if (f.id === 'debtForm') call('apiSaveDebt', formData(f));
  else if (f.id === 'recForm') call('apiSaveRecurring', formData(f));
});

load();
</script>
</body>
</html>`;
