// 세션 불러오기 창: Claude Code·Codex CLI에서 하던 대화를 골라 앱 세션으로 가져온다(원래 기록은 읽기만)
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Modal, Icon, ProviderChip, ago } from '../ui.js';
import { get, post } from '../api.js';
import { t, locale } from '../i18n/index.js';

// 화면 문구(현재 언어로 매번 만든다)
const L = () => ({
  title: t('다른 AI에서 세션 불러오기'),
  intro: t('Claude Code·Codex CLI에서 하던 대화를 골라 여기서 이어서 할 수 있어. 불러올 때 원래 기록은 읽기만 해. Claude는 갈래(포크)로 이어가서 원래 기록이 그대로 남고, Codex는 같은 대화에 이어 붙어(Codex에서도 계속 볼 수 있어).'),
  tabAll: t('전체'),
  tabClaude: 'Claude',
  tabCodex: 'Codex',
  search: t('제목·폴더·내용으로 검색'),
  loading: t('기록 찾는 중…'),
  refreshing: t('찾는 중…'),
  empty: t('불러올 기록이 없어. 이 PC에서 Claude Code나 Codex CLI를 쓴 적이 있는지 확인해줘.'),
  emptyQuery: (q) => t('‘{q}’에 맞는 기록이 없어.', { q }),
  emptyTab: t('이 탭에는 기록이 없어.'),
  loadFail: (e) => t('목록을 못 불러왔어: {e}', { e }),
  retry: t('다시 시도'),
  importBtn: t('불러오기'),
  importing: t('불러오는 중…'),
  importFail: (e) => t('불러오기 실패: {e}', { e }),
  noSessionId: t('서버 응답에 세션 id가 없어.'),
  noFolder: t('(폴더 정보 없음)'),
  folderMissing: t('폴더 없음'),
  folderMissingTip: t('원래 프로젝트 폴더가 이 PC에 없어. 새 작업 폴더에서 최근 대화를 넣어 맥락을 이어가.'),
  archived: t('보관됨'),
  archivedTip: t('Codex 보관함에 있는 기록이야.'),
  messages: (n, approx) => (approx ? t('메시지 {n}개 이상', { n }) : t('메시지 {n}개', { n })),
  groupCount: (n) => t('{n}개', { n }),
  noPreview: t('(미리보기 없음)'),
  close: t('닫기'),
  updated: (d) => t('마지막 활동 {d}', { d }),
});

const keyOf = (it) => `${it.source}:${it.id}`;

export function ImportModal({ onClose, onImported }) {
  const T = L();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [items, setItems] = useState(null); // null = 처음 불러오는 중
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(''); // 불러오는 중인 항목
  const [importErr, setImportErr] = useState('');
  const [reload, setReload] = useState(0);
  const seq = useRef(0);

  // 검색어가 바뀌면 잠깐 기다렸다가 서버에 다시 묻는다(늦게 온 옛 응답은 버림)
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    setErr('');
    const timer = setTimeout(async () => {
      try {
        const r = await get(`/api/import/list?q=${encodeURIComponent(q.trim())}`);
        if (my !== seq.current) return;
        setItems(Array.isArray(r) ? r : r?.items || []);
      } catch (e) {
        if (my !== seq.current) return;
        setErr(e.message);
        setItems((cur) => cur || []);
      }
      if (my === seq.current) setLoading(false);
    }, q.trim() ? 250 : 0);
    return () => clearTimeout(timer);
  }, [q, reload]);

  const list = items || [];
  const counts = useMemo(() => ({
    all: list.length,
    claude: list.filter((x) => x.source === 'claude').length,
    codex: list.filter((x) => x.source === 'codex').length,
  }), [items]);

  // 프로젝트 폴더별로 묶는다(목록이 최신순이라 묶음도 최근 활동 순)
  const groups = useMemo(() => {
    const m = new Map();
    for (const it of list) {
      if (tab !== 'all' && it.source !== tab) continue;
      const k = it.cwd || '';
      if (!m.has(k)) m.set(k, { cwd: k, exists: !!it.cwdExists, items: [] });
      m.get(k).items.push(it);
    }
    return [...m.values()];
  }, [items, tab]);

  const doImport = async (it) => {
    setBusy(keyOf(it));
    setImportErr('');
    try {
      const r = await post('/api/import', { source: it.source, id: it.id });
      if (!r?.sessionId) throw new Error(T.noSessionId);
      onImported?.(r.sessionId);
    } catch (e) {
      setImportErr(T.importFail(e.message));
    } finally {
      setBusy('');
    }
  };

  const Row = (it) => html`<div class="li-row" key=${keyOf(it)}>
    <div class="grow">
      <div class="t ellipsis" title=${it.title}>${it.title}</div>
      <div class="d ellipsis" title=${it.preview || ''}>${it.preview || T.noPreview}</div>
      <div class="row small muted" style="gap:6px;margin-top:4px;flex-wrap:wrap">
        <${ProviderChip} id=${it.source} />
        <span title=${new Date(it.updatedAt).toLocaleString(locale())}>${T.updated(ago(it.updatedAt))}</span>
        <span>${T.messages(it.messageCount, it.messageCountApprox)}</span>
        ${it.archived && html`<span class="chip" title=${T.archivedTip}>${T.archived}</span>`}
      </div>
    </div>
    <button class="btn sm primary" disabled=${!!busy} onClick=${() => doImport(it)}>
      ${busy === keyOf(it) ? html`<span class="spin"></span> ${T.importing}` : html`<${Icon} name="download" /> ${T.importBtn}`}
    </button>
  </div>`;

  const Group = (g) => html`<div key=${g.cwd || '-'} style="margin-bottom:14px">
    <div class="row small" style="gap:6px;margin:0 2px 6px">
      <${Icon} name="folder" size=${14} />
      <span class="mono ellipsis" style="flex:1;min-width:0" title=${g.cwd}>${g.cwd || T.noFolder}</span>
      ${g.cwd && !g.exists && html`<span class="chip warn" title=${T.folderMissingTip}><${Icon} name="alert" size=${12} /> ${T.folderMissing}</span>`}
      <span class="muted">${T.groupCount(g.items.length)}</span>
    </div>
    ${g.cwd && !g.exists && html`<div class="warnbox" style="margin-bottom:6px">${T.folderMissingTip}</div>`}
    <div class="list">${g.items.map(Row)}</div>
  </div>`;

  let body;
  if (items === null) body = html`<div class="empty"><span class="spin"></span> ${T.loading}</div>`;
  else if (err && !list.length) {
    body = html`<div class="empty">
      <p>${T.loadFail(err)}</p>
      <button class="btn" onClick=${() => setReload((n) => n + 1)}><${Icon} name="refresh" /> ${T.retry}</button>
    </div>`;
  } else if (!list.length) body = html`<div class="empty">${q.trim() ? T.emptyQuery(q.trim()) : T.empty}</div>`;
  else if (!groups.length) body = html`<div class="empty">${T.emptyTab}</div>`;
  else body = groups.map(Group);

  // width:0 + min-width:100%: 긴 경로·미리보기(줄바꿈 없음)가 모달 폭을 화면 밖으로 밀지 않게(배경이 grid라 내용 폭을 따라감)
  return html`<${Modal} title=${T.title} onClose=${onClose} size="wide" foot=${html`<button class="btn" onClick=${onClose}>${T.close}</button>`}>
    <div style="width:0;min-width:100%">
    <div class="infobox" style="margin-bottom:12px">${T.intro}</div>
    <div class="row" style="margin-bottom:10px">
      <input class="input" type="search" placeholder=${T.search} value=${q} onInput=${(e) => setQ(e.target.value)} autofocus />
      ${loading && items !== null && html`<span class="muted small row" style="gap:6px;white-space:nowrap"><span class="spin"></span>${T.refreshing}</span>`}
    </div>
    <div class="tabs">
      ${[['all', T.tabAll], ['claude', T.tabClaude], ['codex', T.tabCodex]].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l} <span class="muted small">${counts[k]}</span></button>`)}
    </div>
    ${err && list.length > 0 && html`<div class="warnbox" style="margin-bottom:10px">${T.loadFail(err)}</div>`}
    ${importErr && html`<div class="warnbox" style="margin-bottom:10px">${importErr}</div>`}
    ${body}
    </div>
  </${Modal}>`;
}
