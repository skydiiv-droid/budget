/**
 * Scriptable 흉내.
 *
 * 위젯은 아이폰에서만 도는데, 거기서 처음 돌려 보면 빈 화면이나 에러를 본다.
 * 무엇이 그려지는지를 글자로 뽑아 보면 숫자가 맞는지 · 칸이 비지 않는지까지는
 * 여기서 잡힌다.
 */
export function install(family) {
  const nodes = [];
  const mk = (kind, parent) => {
    const n = { kind, parent, children: [], props: {} };
    nodes.push(n);
    if (parent) parent.children.push(n);
    return n;
  };
  const stackApi = (n) => ({
    _n: n,
    addText(t) {
      const c = mk('text', n);
      c.text = String(t);
      return { set font(v) {}, set textColor(v) { c.color = v; },
               set textOpacity(v) {}, set lineLimit(v) {}, set minimumScaleFactor(v) {} };
    },
    addStack() { return stackApi(mk('stack', n)); },
    addSpacer(v) { mk('spacer', n).size = v; },
    layoutVertically() { n.props.vertical = true; },
    layoutHorizontally() {},
    centerAlignContent() {},
    set size(v) { n.props.size = v; },
    set cornerRadius(v) { n.props.radius = v; },
    set backgroundColor(v) { n.props.bg = v; },
    set spacing(v) {},
    set url(v) {},
  });

  const root = mk('root', null);
  const w = stackApi(root);
  w.setPadding = () => {};
  Object.defineProperty(w, 'backgroundColor', { set(v) { root.props.bg = v; } });
  Object.defineProperty(w, 'refreshAfterDate', { set() {} });
  Object.defineProperty(w, 'url', { set() {} });

  globalThis.ListWidget = function () { return w; };
  globalThis.Color = function (hex) { return { hex }; };
  // 두 벌을 다 들고 있는 색. 이걸 안 거치면 한쪽 모드에서 안 보인다.
  globalThis.Color.dynamic = (light, dark) =>
    ({ dynamic: [light.hex, dark.hex], hex: light.hex });
  globalThis.Font = { systemFont: () => ({}), boldSystemFont: () => ({}) };
  globalThis.Size = function (a, b) { return { w: a, h: b }; };
  globalThis.Script = { setWidget() {}, complete() {} };
  globalThis.Device = { screenSize: () => ({ width: 393, height: 852 }) };
  globalThis.Notification = function () {
    return { schedule: async () => {}, set title(v) {}, set body(v) {},
             set openURL(v) {}, set sound(v) {} };
  };
  globalThis.Request = function (url) {
    return { url, set timeoutInterval(v) {}, loadJSON: async () => globalThis.__DATA };
  };
  globalThis.config = { widgetFamily: family, runsInWidget: true };

  return { root, nodes, w };
}

/** 그려진 것을 글자로. 막대는 [====    ] 로 흉내 낸다. */
export function dump(node, depth = 0) {
  const pad = '  '.repeat(depth);
  const out = [];
  for (const c of node.children) {
    if (c.kind === 'text') out.push(pad + c.text);
    else if (c.kind === 'spacer') continue;
    else if (c.kind === 'stack') {
      if (c.props.bg && c.props.size) {
        const parent = c.children.find((x) => x.props?.size);
        const full = c.props.size.w || 0;
        const fill = parent?.props?.size?.w || 0;
        const n = Math.max(1, Math.round(full / 15));
        const on = Math.round((fill / (full || 1)) * n);
        out.push(`${pad}[${'█'.repeat(on)}${'░'.repeat(Math.max(0, n - on))}]`);
      } else {
        const inner = dump(c, 0);
        if (inner.length) out.push(pad + inner.join('  ·  '));
      }
    }
  }
  return out;
}
