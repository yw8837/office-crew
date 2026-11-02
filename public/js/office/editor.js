// 커스텀 스킨 편집기: 배경 이미지 + 책상 좌표 + 특수 위치 (문구는 i18n 사전)
import { tr, normLang, LANGS } from './i18n.js';

const SPOT_DEFS = [
  { key: 'search', icon: '🔎', need: true },
  { key: 'shelf', icon: '📚', need: true },
  { key: 'server', icon: '🖥', need: true },
  { key: 'meeting', icon: '🗒', need: true },
  { key: 'lounge', icon: '☕', need: false },
  { key: 'door', icon: '🚪', need: false },
];
const MAX_DESKS = 12;
const MAX_SIDE = 2048;
// 어느 언어의 기본 이름이든 "기본 이름"으로 취급(파일 이름으로 바꿔 줄지 판단용)
const DEFAULT_NAMES = new Set(LANGS.map((l) => tr(l, 'ed.defaultName')));

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// 오류는 사전 키로 던지고 화면에 쓸 때 번역
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('ed.errImage'));
    img.src = src;
  });
}
function readFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('ed.errFile'));
    r.readAsDataURL(file);
  });
}
/** 너무 큰 이미지는 줄여서 가볍게(최대 2048px) */
async function normalizeImage(dataURL) {
  const img = await loadImage(dataURL);
  let w = img.naturalWidth, hgt = img.naturalHeight;
  if (!w || !hgt) throw new Error('ed.errSize');
  const k = Math.min(1, MAX_SIDE / Math.max(w, hgt));
  if (k >= 1 && dataURL.length < 2.5e6) return { image: dataURL, width: w, height: hgt };
  w = Math.round(w * k); hgt = Math.round(hgt * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  c.getContext('2d').drawImage(img, 0, 0, w, hgt);
  let out = c.toDataURL('image/webp', 0.9);
  if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/jpeg', 0.9);
  return { image: out, width: w, height: hgt };
}

/**
 * @param {HTMLElement} container
 * @param {{skin?:object, onSave?:(skin)=>void, onCancel?:()=>void, lang?:'ko'|'en'|'zh'|'ja'}} opts
 */
export function createSkinEditor(container, { skin, onSave, onCancel, lang: langOpt } = {}) {
  let lang = normLang(langOpt);
  const T = (k, v) => tr(lang, k, v);
  const spotLabel = (key) => T('ed.spot.' + key);
  const spotFull = (s) => `${spotLabel(s.key)}${s.need ? '' : T('ed.optional')}`;

  const isImg = skin && skin.type === 'image';
  const st = {
    id: isImg && skin.id ? skin.id : `custom-${Date.now().toString(36)}`,
    name: (isImg && skin.name) || T('ed.defaultName'),
    image: isImg ? skin.image : null,
    width: (skin && skin.width) || 0,
    height: (skin && skin.height) || 0,
    desks: skin && Array.isArray(skin.desks) ? skin.desks.map((d) => ({ x: +d.x, y: +d.y })) : [],
    spots: skin && skin.spots ? JSON.parse(JSON.stringify(skin.spots)) : {},
    scale: (skin && +skin.scale) || 0,
    mode: 'desk',
  };

  const root = h('div', 'oc-editor');
  root.tabIndex = 0;
  // 1행: 이름·이미지
  const r1 = h('div', 'oe-row');
  const name = h('input');
  name.type = 'text'; name.value = st.name; name.maxLength = 40;
  const file = h('input');
  file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
  const pickBtn = h('button');
  pickBtn.type = 'button';
  r1.append(name, pickBtn, file);
  // 2행: 모드
  const r2 = h('div', 'oe-row');
  const modeBtns = {};
  const addMode = (key) => {
    const b = h('button');
    b.type = 'button';
    b.addEventListener('click', () => { st.mode = key; render(); });
    modeBtns[key] = b;
    r2.append(b);
  };
  addMode('desk');
  for (const s of SPOT_DEFS) addMode(s.key);
  const scaleWrap = h('label', 'oe-hint');
  const scaleTxt = h('span');
  const scale = h('input');
  scale.type = 'range'; scale.min = '0.3'; scale.max = '2.5'; scale.step = '0.05';
  scaleWrap.append(scaleTxt, scale);
  r2.append(scaleWrap);
  const hint = h('div', 'oe-hint');
  const stage = h('div', 'oe-stage');
  const legend = h('div', 'oe-legend');
  const err = h('div', 'oe-err');
  const r3 = h('div', 'oe-row');
  r3.style.justifyContent = 'flex-end';
  const cancelBtn = h('button'); cancelBtn.type = 'button';
  const saveBtn = h('button', 'primary'); saveBtn.type = 'button';
  r3.append(cancelBtn, saveBtn);
  root.append(r1, r2, hint, stage, legend, err, r3);
  container.append(root);

  /** 고정 UI 문구 채우기(언어 바꿀 때도 호출) */
  function labelUI() {
    root.lang = lang;
    name.placeholder = T('ed.namePh');
    name.setAttribute('aria-label', T('ed.namePh'));
    pickBtn.textContent = T('ed.pick');
    modeBtns.desk.textContent = T('ed.deskMode');
    for (const s of SPOT_DEFS) modeBtns[s.key].textContent = `${s.icon} ${spotFull(s)}`;
    scaleTxt.textContent = ` ${T('ed.charSize')} `;
    cancelBtn.textContent = T('ed.cancel');
    saveBtn.textContent = T('ed.save');
  }

  let wrap = null, img = null;
  const autoScale = () => Math.max(0.3, Math.min(2.5, Math.min(st.width, st.height) / 900 || 1));

  function toImg(e) {
    const r = img.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * st.width;
    const y = ((e.clientY - r.top) / r.height) * st.height;
    return { x: Math.round(Math.max(0, Math.min(st.width, x))), y: Math.round(Math.max(0, Math.min(st.height, y))) };
  }

  function marker(text, x, y, cls, onMove, onDelete) {
    const m = h('div', `oe-mk ${cls}`, text);
    m.style.left = `${(x / st.width) * 100}%`;
    m.style.top = `${(y / st.height) * 100}%`;
    m.title = T('ed.markerTip');
    m.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      m.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const p = toImg(ev);
        onMove(p);
        m.style.left = `${(p.x / st.width) * 100}%`;
        m.style.top = `${(p.y / st.height) * 100}%`;
      };
      const up = () => { m.removeEventListener('pointermove', move); m.removeEventListener('pointerup', up); render(); };
      m.addEventListener('pointermove', move);
      m.addEventListener('pointerup', up);
    });
    m.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); onDelete(); render(); });
    return m;
  }

  function render() {
    name.value = st.name;
    for (const k in modeBtns) modeBtns[k].classList.toggle('on', st.mode === k);
    scale.value = String(st.scale || autoScale());
    hint.textContent = !st.image
      ? T('ed.hintEmpty')
      : st.mode === 'desk'
        ? T('ed.hintDesk', { max: MAX_DESKS })
        : T('ed.hintSpot', { label: spotLabel(st.mode) });
    stage.replaceChildren();
    if (!st.image) {
      const empty = h('div', 'oe-empty');
      empty.append(h('div', null, '🖼'), h('div', null, T('ed.dropHere')), h('div', 'oe-hint', T('ed.formats')));
      stage.append(empty);
      wrap = img = null;
    } else {
      wrap = h('div', 'oe-wrap');
      img = h('img');
      img.src = st.image;
      img.alt = T('ed.bgAlt');
      img.draggable = false;
      img.style.maxHeight = `${Math.max(160, stage.clientHeight - 16)}px`;
      wrap.append(img);
      st.desks.forEach((d, i) => {
        wrap.append(marker(String(i + 1), d.x, d.y, 'desk', (p) => { d.x = p.x; d.y = p.y; }, () => { st.desks.splice(i, 1); }));
      });
      for (const s of SPOT_DEFS) {
        const p = st.spots[s.key];
        if (!p) continue;
        wrap.append(marker(`${s.icon} ${spotLabel(s.key)}`, p.x, p.y, 'spot', (q) => { p.x = q.x; p.y = q.y; }, () => { delete st.spots[s.key]; }));
      }
      wrap.addEventListener('pointerdown', onStageClick);
      wrap.addEventListener('contextmenu', (e) => e.preventDefault());
      stage.append(wrap);
    }
    const need = SPOT_DEFS.filter((s) => s.need);
    const have = need.filter((s) => st.spots[s.key]).length;
    legend.replaceChildren(
      h('span', null, T('ed.desks', { n: st.desks.length, max: MAX_DESKS })),
      h('span', null, T('ed.spots', { n: have, m: need.length })),
      h('span', null, st.image ? T('ed.imageSize', { w: st.width, h: st.height }) : T('ed.noImage')),
    );
  }

  function onStageClick(e) {
    if (e.button !== 0 || !img) return;
    if (e.target.classList && e.target.classList.contains('oe-mk')) return;
    const p = toImg(e);
    err.textContent = '';
    if (st.mode === 'desk') {
      if (st.desks.length >= MAX_DESKS) { err.textContent = T('ed.maxDesks', { max: MAX_DESKS }); return; }
      st.desks.push(p);
    } else {
      st.spots[st.mode] = p;
      // 다음 미지정 특수 위치로 자동 이동
      const nxt = SPOT_DEFS.find((s) => s.need && !st.spots[s.key]);
      if (nxt) st.mode = nxt.key;
    }
    render();
  }

  async function takeFile(f) {
    if (!f || !/^image\//.test(f.type)) { err.textContent = T('ed.onlyImage'); return; }
    try {
      err.textContent = T('ed.loading');
      const raw = await readFile(f);
      const n = await normalizeImage(raw);
      const sx = st.width ? n.width / st.width : 1, sy = st.height ? n.height / st.height : 1;
      if (st.image && st.width) {
        // 이미지 교체 시 기존 좌표를 비율로 옮김
        st.desks.forEach((d) => { d.x = Math.round(d.x * sx); d.y = Math.round(d.y * sy); });
        for (const k in st.spots) { st.spots[k].x = Math.round(st.spots[k].x * sx); st.spots[k].y = Math.round(st.spots[k].y * sy); }
      }
      Object.assign(st, n);
      if (!st.scale) st.scale = 0;
      err.textContent = '';
      if (!isImg && (!name.value || DEFAULT_NAMES.has(name.value))) {
        st.name = (f.name || '').replace(/\.[^.]+$/, '').slice(0, 40) || T('ed.defaultName');
      }
      render();
    } catch (ex) {
      err.textContent = T((ex && ex.message) || String(ex));
    }
  }

  pickBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { takeFile(file.files && file.files[0]); file.value = ''; });
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('drag');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) takeFile(f);
  });
  const onPaste = (e) => {
    if (!root.isConnected) return;
    const items = e.clipboardData ? [...e.clipboardData.items] : [];
    const it = items.find((x) => x.kind === 'file' && /^image\//.test(x.type));
    if (!it) return;
    e.preventDefault();
    takeFile(it.getAsFile());
  };
  document.addEventListener('paste', onPaste);
  name.addEventListener('input', () => { st.name = name.value; });
  scale.addEventListener('input', () => { st.scale = +scale.value; });
  cancelBtn.addEventListener('click', () => { if (onCancel) onCancel(); });
  saveBtn.addEventListener('click', () => {
    if (!st.image) { err.textContent = T('ed.needImage'); return; }
    if (!st.desks.length) { err.textContent = T('ed.needDesk'); return; }
    const missing = SPOT_DEFS.filter((s) => s.need && !st.spots[s.key]);
    if (missing.length && !saveBtn.dataset.confirm) {
      err.textContent = T('ed.missingSpots', { list: missing.map((s) => spotLabel(s.key)).join(T('ed.listSep')) });
      saveBtn.dataset.confirm = '1';
      return;
    }
    delete saveBtn.dataset.confirm;
    const spots = {};
    for (const s of SPOT_DEFS) if (st.spots[s.key]) spots[s.key] = { x: st.spots[s.key].x, y: st.spots[s.key].y };
    const out = {
      id: st.id, name: (st.name || '').trim() || T('ed.defaultName'), type: 'image',
      image: st.image, width: st.width, height: st.height,
      desks: st.desks.map((d) => ({ x: d.x, y: d.y })), spots,
      scale: st.scale || autoScale(),
    };
    if (onSave) onSave(out);
  });

  // 편집 영역 크기가 바뀌면 이미지 전체가 보이게 다시 맞춤
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (img) img.style.maxHeight = `${Math.max(160, stage.clientHeight - 16)}px`; }) : null;
  if (ro) ro.observe(stage);

  if (st.image && (!st.width || !st.height)) {
    loadImage(st.image).then((im) => { st.width = im.naturalWidth; st.height = im.naturalHeight; render(); }).catch(() => {});
  }
  labelUI();
  render();

  return {
    el: root,
    getSkin() { return JSON.parse(JSON.stringify({ ...st, mode: undefined })); },
    /** 편집기 언어 바꾸기(입력 중인 내용은 유지) */
    setLanguage(l) {
      const wasDefault = DEFAULT_NAMES.has(st.name);
      lang = normLang(l || 'en');
      if (wasDefault) st.name = T('ed.defaultName');
      err.textContent = '';
      labelUI();
      render();
    },
    destroy() {
      document.removeEventListener('paste', onPaste);
      if (ro) ro.disconnect();
      root.remove();
    },
  };
}
