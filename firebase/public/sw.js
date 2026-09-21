/**
 * 껍데기를 기기에 담아 둔다.
 *
 * Firestore 가 읽은 내용을 남겨 둬도, 화면을 그리는 파일(html · css · js)을
 * 못 받으면 흰 화면이다. 병원 지하에서 열면 딱 그 꼴이 난다.
 *
 * 규칙은 둘뿐이다.
 *   화면 파일  담아 둔 걸 먼저 주고, 뒤에서 새것을 받아 갈아 둔다.
 *              — 늦게 뜨는 것보다 한 판 묵은 게 낫다. 다음에 열면 새것이다.
 *   그 밖의 것  건드리지 않는다. 특히 **Firestore 와 함수는 절대 담지 않는다** —
 *              돈이 걸린 숫자를 묵은 걸로 주면 안 되고, 그쪽은 제 나름의
 *              오프라인 장치가 따로 있다.
 */

const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;

/**
 * 미리 담아 둘 것.
 *
 * 화면이 뜨려면 껍데기만으로는 모자란다 — `app.js` 와 그것이 불러들이는
 * 공용 로직까지 있어야 앱이 돈다. 공용 로직은 파일이 계속 늘어나므로 여기에
 * 적어 두지 않고, 한 번 지나갈 때 아래 fetch 에서 알아서 담는다.
 */
const FILES = [
  '/',
  '/index.html',
  '/app.js',
  '/app.css',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon.svg',
];

/** 파이어베이스 SDK. 남의 집이지만 이게 없으면 앱이 아예 안 돈다. */
const VENDOR = /^https:\/\/www\.gstatic\.com\/firebasejs\//;

self.addEventListener('install', (e) => {
  // 하나라도 못 받으면 통째로 실패한다. 아이콘 때문에 껍데기를 못 담으면 곤란하다.
  e.waitUntil(caches.open(SHELL)
    .then((c) => Promise.allSettled(FILES.map((f) => c.add(f))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** 우리 집 파일인가. 남의 집 것은 손대지 않는다. */
const mine = (url) => url.origin === self.location.origin;

/** 담아 둬도 되는 것인가. 데이터는 안 된다. */
function cacheable(url) {
  if (VENDOR.test(url.href)) return true;
  if (!mine(url)) return false;
  // 프로젝트 설정. 이게 없으면 앱이 아예 못 뜬다 — 오프라인에서도 있어야 한다.
  // 공개돼도 되는 값만 들어 있고(웹앱에 그대로 박히는 값이다) 잔고는 없다.
  if (url.pathname === '/__/firebase/init.json') return true;
  if (url.pathname.startsWith('/__/')) return false;
  if (url.pathname === '/sw.js') return false;
  return /\.(html|css|js|png|svg|webmanifest|woff2?)$/.test(url.pathname)
    || url.pathname === '/'
    || url.pathname === '/data';
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !cacheable(url)) return;

  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(e.request, { ignoreSearch: true });

    // 뒤에서 새것을 받아 둔다. 실패해도 조용히 넘어간다 — 지금 줄 건 이미 있다.
    const fresh = fetch(e.request)
      .then((res) => {
        // 남의 집 응답(type: 'cors')도 담는다. 불투명한 것(opaque)만 거른다 —
        // 그건 성공인지 아닌지조차 알 수 없어서 담으면 두고두고 말썽이다.
        if (res && res.ok && res.type !== 'opaque') cache.put(e.request, res.clone());
        return res;
      })
      .catch(() => null);

    if (hit) return hit;
    const res = await fresh;
    if (res) return res;

    // 담아 둔 것도 없고 받지도 못했다. 화면을 달라는 것이면 첫 화면이라도 준다.
    if (e.request.mode === 'navigate') {
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }
    return new Response('오프라인입니다.', {
      status: 503, headers: { 'content-type': 'text/plain;charset=utf-8' },
    });
  })());
});
