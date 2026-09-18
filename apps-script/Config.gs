/**
 * 전역 설정.
 *
 * 비밀값(수집 토큰)은 코드에 두지 않고 스크립트 속성에 둔다.
 *   Apps Script 편집기 > 프로젝트 설정 > 스크립트 속성
 *     INGEST_TOKEN = <아무 긴 랜덤 문자열>
 */
const CONFIG = {
  timezone: 'Asia/Seoul',

  // 한 달 사이클 시작일. 1이면 1일~말일.
  cycleStartDay: 1,

  // 파서 버전. 패턴을 고칠 때마다 올린다.
  // RawMessage에 기록해두고, 구버전으로 파싱된 문자만 골라 재처리한다.
  parserVersion: 1,

  // 승인취소 문자가 원거래를 찾을 때 거슬러 올라가는 기간
  voidMatchWindowDays: 60,

  // 은행 출금과 카드 승인이 같은 거래일 때 짝을 찾는 시간 허용 오차
  crossMatchWindowMinutes: 2,
};

function getIngestToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('INGEST_TOKEN');
  if (!token) throw new Error('스크립트 속성 INGEST_TOKEN이 없습니다.');
  return token;
}
