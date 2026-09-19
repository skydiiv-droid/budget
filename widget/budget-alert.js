/**
 * 결제일·고정비 전날 알림 — Scriptable.
 *
 * 위젯은 봐야 보이는데 이건 안 봐도 온다. 카드값이 빠지기 전날 통장에 돈이
 * 있는지 보게 하는 게 목적이다 — 잔고가 모자라 연체되면 이자보다 아프다.
 *
 * 넣는 방법
 *   1. Scriptable 에 이 파일을 새 스크립트로 붙여 넣고 TOKEN 을 바꾼다
 *   2. 단축어 앱 > 자동화 > 새 자동화 > 시간대
 *      매일 오전 9시 · 즉시 실행 켬
 *   3. 동작에 "스크립트 실행"(Scriptable) 을 넣고 이 스크립트를 고른다
 *
 * 알릴 게 없으면 아무것도 안 뜬다. 매일 오는 알림은 며칠이면 안 보게 된다.
 */

const TOKEN = '여기에-위젯-비밀번호';
const URL = 'https://summary-6ygn4mmscq-du.a.run.app';

/** 며칠 전부터 알릴까. 하루 전이면 옮길 시간이 없다. */
const DAYS_AHEAD = 2;

const won = (n) => '₩' + Math.round(Number(n) || 0).toLocaleString('ko-KR');

const req = new Request(`${URL}?token=${encodeURIComponent(TOKEN)}`);
req.timeoutInterval = 10;
const d = await req.loadJSON();

const lines = [];

if (d.ok && d.nextBill && d.nextBill.daysLeft <= DAYS_AHEAD) {
  const when = d.nextBill.daysLeft === 0 ? '오늘'
    : d.nextBill.daysLeft === 1 ? '내일' : `${d.nextBill.daysLeft}일 뒤`;
  lines.push(`${when} 카드값 ${won(d.billTotal)} 빠져요`);
}

// 예산을 다 쓴 날도 알려 준다. 다 쓰고 나서 아는 것보다 낫다.
if (d.ok && d.budget && d.usedPct >= 100) {
  lines.push(`이 달 생활비 예산을 다 썼어요 (${d.usedPct}%)`);
} else if (d.ok && d.budget && d.projected > d.budget * 1.15 && d.daysLeft > 3) {
  lines.push(`이 속도면 예산을 ${won(d.projected - d.budget)} 넘겨요`);
}

if (lines.length) {
  const n = new Notification();
  n.title = '가계부';
  n.body = lines.join('\n');
  n.openURL = 'https://budget-13aec.web.app';
  n.sound = 'default';
  await n.schedule();
}

Script.complete();
