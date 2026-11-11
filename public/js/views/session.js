// 세션 화면: 사무실(실시간) + 채팅 + 입력창 + 진행 바 + 승인/오류 카드 + 에이전트 상세
import { Component } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Icon, Avatar, ProviderChip, STATE_LABEL, EFFORT_LABEL, fmtTok, fmtCost, fmtDur, usageTotal, officeMod, agentModelText } from '../ui.js';
import { state, changed, toast, agentById, teamById, latestRun, onServerEvent, loadSession, uiLang } from '../state.js';
import { post, patch, upload, uploadUrl } from '../api.js';
import { renderMarkdown } from '../markdown.js';
import { t, getLang, locale, tmap } from '../i18n/index.js';
import { MemoryBadge } from './memory.js';

export const sessionAgents = (s) => {
  if (!s) return [];
  const ids = new Set();
  const team = s.teamId ? teamById(s.teamId) : null;
  if (team) for (const st of team.stages) for (const id of st.agentIds) ids.add(id);
  else if (s.agentId) ids.add(s.agentId);
  else if (state.settings.defaultAgentId) ids.add(state.settings.defaultAgentId);
  for (const m of s.messages) if (m.agentId) ids.add(m.agentId);
  for (const id of Object.keys(state.live[s.id] || {})) ids.add(id);
  return [...ids].map(agentById).filter(Boolean);
};

// 작성 중(실제 토큰 보고 전)인 메시지는 추정 출력 토큰(estOutput)을 더해 실시간으로 보여준다
function addUsage(u, m) {
  for (const k in u) u[k] += m.usage[k] || 0;
  if (!m.usage.output && m.usage.estOutput) { u.output += m.usage.estOutput; u.estimated = true; }
}
function agentUsage(s, agentId) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const m of s?.messages || []) if (m.agentId === agentId && m.usage) addUsage(u, m);
  return u;
}
function sessionUsage(s) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const m of s?.messages || []) if (m.usage) addUsage(u, m);
  return u;
}

// ── 활동 로그(세션별 최근 상태 변화) ──
const logs = {};
onServerEvent((type, d) => {
  if (type !== 'agentState' && type !== 'handoff') return;
  const L = (logs[d.sessionId] ||= []);
  if (type === 'handoff') L.push({ at: Date.now(), agentId: d.from, text: `📄 ${t('{name}에게 결과 전달 ({label})', { name: agentById(d.to)?.name || d.to, label: d.label })}` });
  else {
    const prev = [...L].reverse().find((x) => x.agentId === d.agentId);
    const text = `${STATE_LABEL[d.state] || d.state}${d.tool ? ` · ${d.tool}` : ''}`;
    if (prev?.text === text) return;
    L.push({ at: Date.now(), agentId: d.agentId, text });
  }
  if (L.length > 200) L.splice(0, L.length - 200);
});

// 지금 회의 중인 단계의 참석자(없으면 빈 목록). 마을에서 한자리에 모으는 데 쓴다
function meetingIds(s) {
  const r = latestRun(s);
  const st = r && !r.endedAt && r.stages[r.stageIndex];
  return st && st.meetingNow ? st.agentIds : [];
}
// 회의 차례 이름: 의견 1/2, 검토 2/2, 결론
const meetLabel = (m) => (m.phase === 'conclude' ? t('결론') : m.phase === 'opinion' ? t('의견 {r}/{n}', { r: m.round, n: m.rounds }) : t('검토 {r}/{n}', { r: m.round, n: m.rounds }));

// ── 사무실 패널 ──
// 사무실 기본 높이: 화면의 30%쯤, 200~300px 사이(대화가 주인공이라 절반을 넘지 않게)
const officeDefaultH = () => Math.max(200, Math.min(300, Math.round(innerHeight * 0.3)));
function OfficePanel({ s, full, onCollapse }) {
  const host = useRef(null);
  const officeRef = useRef(null);
  const [height, setHeight] = useState(() => Number(localStorage.getItem('ui.officeH')) || officeDefaultH());
  const agents = sessionAgents(s);
  const key = agents.map((a) => `${a.id}:${a.name}:${a.model}:${avatarKey(a.avatar)}`).join('|');
  const mod = officeMod.m;

  const meta = (a) => ({ id: a.id, name: a.name, role: a.role, model: agentModelText(a, state.sessionData[s.id]), color: providerColorOf(a), avatar: a.avatar || {} });
  const meetKey = meetingIds(s).join(',');

  useEffect(() => {
    if (!mod || !host.current) return undefined;
    const office = mod.createOffice(host.current, {
      skin: skinValue(), reducedMotion: !!state.settings.reducedMotion, lang: uiLang(), quality: state.settings.officeQuality || 'full',
      onSelect: (id) => { state.ui.inspector = id; changed(); },
    });
    officeRef.current = office;
    host.current.__office = office; // 점검·테스트용(getSnapshot)
    return () => { office.destroy(); officeRef.current = null; };
  }, [mod]);

  useEffect(() => {
    const o = officeRef.current;
    if (!o) return;
    o.setAgents(agents.map(meta));
    const live = state.live[s.id] || {};
    for (const a of agents) {
      const l = live[a.id];
      const u = agentUsage(s, a.id);
      o.setState(a.id, { state: l?.state || 'idle', text: l?.detail || '', tool: l?.tool || null, tokens: usageTotal(u), badge: badgeFor(a, u), meeting: meetKey.split(',').includes(a.id) });
    }
  }, [key, s.id, mod, meetKey]);

  useEffect(() => { officeRef.current?.setSkin(skinValue()); }, [state.settings.skin, state.skins.length]);
  useEffect(() => { officeRef.current?.setLanguage?.(uiLang()); }, [state.settings.lang]);
  useEffect(() => { officeRef.current?.setQuality?.(state.settings.officeQuality || 'full'); }, [state.settings.officeQuality]);
  useEffect(() => { officeRef.current?.select(state.ui.inspector || null); }, [state.ui.inspector]);

  // 서브에이전트(Claude의 Task/Agent 도구) → 꼬마 도우미 출근·퇴근
  const helpers = useRef(new Map());
  useEffect(() => onServerEvent((type, d) => {
    const o = officeRef.current;
    if (!o || d.sessionId !== s.id) return;
    if (type === 'agentState') {
      const a = agentById(d.agentId);
      const u = agentUsage(state.sessionData[s.id], d.agentId);
      if (a && !agents.some((x) => x.id === a.id)) o.setAgents([...agents, a].map(meta));
      o.setState(d.agentId, { state: d.state, text: d.detail, tool: d.tool, tokens: usageTotal(u), badge: a ? badgeFor(a, u) : '', meeting: meetingIds(state.sessionData[s.id] || s).includes(d.agentId) });
      // 도우미는 Task/Agent 도구가 실행 중이거나(끝나면 state 가 thinking 으로 바뀜) 하위 도구(↳)가 도는 동안만 머문다
      const tool = d.tool || '';
      const keep = (/^(Task|Agent)$/i.test(tool) && !['thinking', 'done', 'error', 'paused', 'idle'].includes(d.state)) || tool.startsWith('↳');
      const hid = helpers.current.get(d.agentId);
      if (keep && !hid && o.spawnHelper) helpers.current.set(d.agentId, o.spawnHelper(d.agentId, { label: t('서브에이전트') }));
      else if (!keep && hid) { helpers.current.delete(d.agentId); o.dismissHelper?.(hid); }
    } else if (type === 'handoff') o.handoff(d.from, d.to, d.label);
  }), [s.id, key, mod]);
  useEffect(() => () => helpers.current.clear(), [s.id, mod]);

  const startDrag = (e) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = height;
    const mv = (ev) => setHeight(Math.max(180, Math.min(innerHeight - 260, h0 + ev.clientY - y0)));
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); localStorage.setItem('ui.officeH', String(Math.round(host.current?.parentElement?.offsetHeight || h0))); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  };
  const resetHeight = () => { localStorage.removeItem('ui.officeH'); setHeight(officeDefaultH()); };

  return html`<div class=${`office-wrap${full ? ' full' : ''}`} style=${full ? '' : `height:${height}px`}>
    ${!mod && html`<div class="empty">${t('사무실 그래픽을 불러오는 중…')}</div>`}
    <div class="office-host" ref=${host}></div>
    <div class="office-tools">
      <select class="select" style="width:auto;padding:4px 8px;font-size:12px" value=${state.settings.skin} onChange=${(e) => setSkin(e.target.value)} title=${t('사무실 스킨')}>
        ${(mod?.SKINS || []).map((k) => html`<option value=${k.id}>${mod.skinName ? mod.skinName(k, uiLang()) : k.name}</option>`)}
        ${state.skins.map((k) => html`<option value=${k.id}>${k.type === 'village' ? '🏡' : '🖼'} ${k.name}</option>`)}
      </select>
      ${!full && onCollapse && html`<button class="btn sm" onClick=${onCollapse} title=${t('사무실 접기 (채팅만 보기)')} aria-label=${t('사무실 접기 (채팅만 보기)')}><${Icon} name="up" size=${14} /> ${t('접기')}</button>`}
    </div>
    ${!full && html`<div class="resizer" onPointerDown=${startDrag} onDblClick=${resetHeight} title=${t('드래그해서 높이 조절 · 두 번 누르면 기본 크기')}></div>`}
  </div>`;
}

const providerColorOf = (a) => ({ claude: '#d97757', codex: '#10a37f', gemini: '#8e75ff', hermes: '#7c3aed', openai: '#0ea5e9', mock: '#64748b' }[String(a.provider || '').replace(/^codex-[a-z0-9]+$/, 'codex')] || '#888');
// 태그에 토큰은 office 가 따로 보여주므로 배지는 비용만
function badgeFor(a, u) {
  return u.cost ? fmtCost(u.cost) : '';
}
// 사무실 갱신 키: 그림(data URL)은 통째로 넣지 않고 길이·끝부분만(렌더마다 큰 문자열 직렬화 방지)
function avatarKey(av) {
  if (!av) return '';
  const { image, ...rest } = av;
  return JSON.stringify(rest) + (typeof image === 'string' ? `#${image.length}:${image.slice(-24)}` : '');
}

function skinValue() {
  const id = state.settings.skin || 'village';
  return state.skins.find((k) => k.id === id) || id;
}
async function setSkin(id) {
  try { state.settings = await (await import('../api.js')).put('/api/settings', { skin: id }); changed(); } catch (e) { toast(e.message, 'error'); }
}

async function resend(m) {
  const sid = state.route.id;
  try { await post(`/api/sessions/${sid}/messages`, { text: m.text, attachments: (m.attachments || []).map((a) => a.id), mention: m.mention || null }); } catch (e) { toast(e.message, 'error'); }
}

// 대화를 마크다운 파일로 저장
export function exportMarkdown(s) {
  const lines = [`# ${s.title}`, '', `> ${t('오피스 크루')} · ${new Date(s.createdAt).toLocaleString(locale())}`, ''];
  for (const m of s.messages) {
    if (m.role === 'user') lines.push(`## 🙋 ${t('나')}${m.mention ? ` → @${agentById(m.mention)?.name || ''}` : ''}`, '', m.text, '');
    else if (m.role === 'agent') {
      const a = agentById(m.agentId);
      lines.push(`## ${a?.emoji || '🤖'} ${a?.name || m.agentId}${m.stageLabel ? ` · ${m.stageLabel}` : ''} (${m.model || ''})`, '', m.text || '', '');
      if (m.error) lines.push(`> ⚠ ${m.error}`, '');
    } else lines.push(`*${m.text}*`, '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${s.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'session'}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── 메시지 ──
class Message extends Component {
  shouldComponentUpdate(np) { return np.m._v !== this.v || np.m !== this.props.m || np.compact !== this.props.compact || getLang() !== this.lang; }
  render({ m }) {
    this.v = m._v;
    this.lang = getLang();
    if (m.role === 'user') {
      const ag = m.mention ? agentById(m.mention) : null;
      return html`<div class="msg user"><div>
        <div class="bubble">
          ${m.attachments?.length ? html`<div class="att">${m.attachments.map((a) => html`<${AttThumb} a=${a} />`)}</div>` : ''}
          ${ag && html`<span class="mention">@${ag.name} </span>`}${m.text}
        </div>
        <div class="msg-foot meta" style="justify-content:flex-end">${m.status === 'queued' ? html`<span class="chip warn">${t('대기열 — 지금 작업 끝나면 실행')}</span>` : ''}
          <span class="act">
            <button class="btn ghost sm" title=${t('입력창으로 가져와 고쳐 보내기')} onClick=${() => { state.ui.draft = m.text; changed(); }}><${Icon} name="edit" /> ${t('고쳐 쓰기')}</button>
            <button class="btn ghost sm" title=${t('같은 내용으로 다시 실행')} onClick=${() => resend(m)}><${Icon} name="refresh" /> ${t('다시 보내기')}</button>
          </span></div>
      </div></div>`;
    }
    if (m.role === 'system') return html`<div class="msg system"><span>${m.text}</span></div>`;
    const a = agentById(m.agentId) || { name: t('삭제된 에이전트'), emoji: '❔' };
    const streaming = m.status === 'streaming';
    const tools = m.blocks.filter((b) => b.kind === 'tool');
    const thinking = m.blocks.find((b) => b.kind === 'thinking');
    const notices = m.blocks.filter((b) => b.kind === 'notice' && !b.quiet);
    const quiet = m.blocks.filter((b) => b.kind === 'notice' && b.quiet);
    const u = m.usage || {};
    return html`<div class=${`msg agent${streaming ? ' streaming' : ''}`} data-agent=${m.agentId}>
      <${Avatar} agent=${a} />
      <div style="min-width:0">
        <div class="msg-head">
          <b>${a.name}</b>${m.stageLabel ? html`<span class="chip">${m.stageLabel}</span>` : ''}${m.meeting ? html`<span class=${`chip${m.meeting.phase === 'conclude' ? ' accent' : ''}`}>${meetLabel(m.meeting)}</span>` : ''}
          <${ProviderChip} id=${m.provider} />
          ${m.model && html`<span class="chip mono">${m.model}${m.effort ? ` · ${EFFORT_LABEL[m.effort] || m.effort}` : ''}</span>`}
          ${streaming && html`<span class="spin"></span>`}
        </div>
        ${(thinking || tools.length) ? html`<div class="blocks">
          ${thinking && html`<details class="blk thinking"><summary><span class="st">💭</span><span class="nm">${t('생각')}</span><span class="arg">${thinking.text.slice(-120)}</span></summary><pre>${thinking.text}</pre></details>`}
          ${tools.length > 6 ? html`<details class="tools-group"><summary>${t('도구 {n}개 사용 (펼치기)', { n: tools.length })}</summary><div class="blocks">${tools.map((b) => html`<${ToolBlock} b=${b} />`)}</div></details>`
            : tools.map((b) => html`<${ToolBlock} b=${b} />`)}
        </div>` : ''}
        ${notices.map((b) => html`<div class="notice">${b.text}</div>`)}
        <div class="msg-body md" dangerouslySetInnerHTML=${{ __html: m.text ? renderMarkdown(m.text) : (streaming ? `<p class="muted">${t('작업 중…')}</p>` : '') }}></div>
        ${m.error && html`<div class="msg-err">⚠ ${m.error}</div>`}
        <div class="msg-foot">
          ${m.status === 'stopped' && html`<span class="chip warn">${t('중지됨')}</span>`}
          ${usageTotal(u) > 0 && html`<span title=${t('입력 {i} · 출력 {o} · 캐시 읽기 {cr} · 캐시 쓰기 {cw}', { i: u.input, o: u.output, cr: u.cacheRead, cw: u.cacheWrite })}>${t('{n} 토큰', { n: fmtTok(usageTotal(u)) })}</span>`}
          ${!usageTotal(u) && u.estOutput > 0 && html`<span title=${t('CLI가 턴을 끝내면 실제 값으로 바뀌어')}>~${t('{n} 토큰 (작성 중 추정)', { n: fmtTok(u.estOutput) })}</span>`}
          ${u.cost > 0 && html`<span>${fmtCost(u.cost)}</span>`}
          ${u.durationMs > 0 && !streaming && html`<span>${fmtDur(u.durationMs)}</span>`}
          ${quiet.length > 0 && html`<span title=${quiet.map((q) => q.text).join('\n')}>${t('알림 {n}', { n: quiet.length })}</span>`}
          <span class="act"><button class="btn ghost sm" onClick=${() => { navigator.clipboard?.writeText(m.text); toast(t('복사했어'), 'ok', 1500); }}><${Icon} name="copy" /> ${t('복사')}</button></span>
        </div>
      </div>
    </div>`;
  }
}

function ToolBlock({ b }) {
  const arg = typeof b.input === 'string' ? b.input : b.input ? Object.values(b.input).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ').slice(0, 200) : '';
  const icon = b.status === 'running' ? html`<span class="spin"></span>` : b.status === 'error' ? '⚠' : '✓';
  return html`<details class="blk"><summary><span class="st">${icon}</span><span class="nm">${b.name}</span><span class="arg">${arg}</span></summary>
    ${b.input && html`<pre>${typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2)}</pre>`}
    ${b.output && html`<pre>${b.output}</pre>`}
  </details>`;
}

function AttThumb({ a, onRemove, uploading }) {
  const img = a.mime?.startsWith('image/');
  return html`<div class=${`att${uploading ? ' up' : ''}`} title=${a.name}>
    ${img ? html`<img src=${a.preview || uploadUrl(a.id)} alt=${a.name} />` : html`<div class="ic">📄</div>`}
    <span class="ellipsis" style="max-width:130px">${a.name}</span>
    ${onRemove && html`<button class="rm" title=${t('빼기')} onClick=${onRemove}>✕</button>`}
  </div>`;
}

const CHAT_WINDOW = 40; // 한 번에 그리는 메시지 수
function Chat({ s, run }) {
  const ref = useRef(null);
  const stick = useRef(true);
  const last = s.messages[s.messages.length - 1];
  // 긴 대화는 최근 것만 그린다(전부 그리면 화면이 무거워진다). 위의 버튼으로 더 불러온다
  const [shown, setShown] = useState(CHAT_WINDOW);
  const grow = useRef(0); // 더 불러오기 직전의 전체 높이(불러온 뒤 보던 자리를 지키려고)
  const hidden = Math.max(0, s.messages.length - shown);
  const visible = hidden ? s.messages.slice(hidden) : s.messages;
  const showMore = () => { grow.current = ref.current?.scrollHeight || 0; stick.current = false; setShown((n) => n + CHAT_WINDOW); };
  useEffect(() => {
    const el = ref.current;
    if (el && grow.current) { el.scrollTop += el.scrollHeight - grow.current; grow.current = 0; }
    else if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => { setShown(CHAT_WINDOW); stick.current = true; const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [s.id]);
  const onScroll = (e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  return html`<div class="chat" ref=${ref} onScroll=${onScroll}>
    <div class="chat-inner">
      ${hidden > 0 && html`<button class="chat-more" onClick=${showMore}>${t('이전 대화 {n}개 더 보기', { n: Math.min(hidden, CHAT_WINDOW) })} <span class="muted">${t('(남은 {n}개)', { n: hidden })}</span></button>`}
      ${s.messages.length === 0 ? html`<${Welcome} s=${s} />` : visible.map((m) => html`<${Message} key=${m.id} m=${m} />`)}
      ${/* 승인·오류 카드는 결과 바로 아래(채팅 흐름 안)에 둬서 결과를 가리지 않게 */ ''}
      <${Gate} s=${s} run=${run} inline=${true} />
      ${last && html`<div style="height:4px"></div>`}
    </div>
  </div>`;
}

function Welcome({ s }) {
  const team = s.teamId ? teamById(s.teamId) : null;
  const agent = !team ? agentById(s.agentId || state.settings.defaultAgentId) : null;
  const starters = [
    [`🔎 ${t('시장 조사')}`, t('요즘 1인 창업 아이템 트렌드를 조사하고 정리해줘')],
    [`🧠 ${t('분석·계획')}`, t('내 블로그 방문자를 늘릴 방법을 분석하고 실행 계획을 세워줘')],
    [`🛠 ${t('빌드')}`, t('할 일 목록 웹페이지(HTML 한 파일)를 만들어줘')],
    [`📄 ${t('문서 정리')}`, t('첨부한 자료를 핵심만 표로 정리해줘')],
  ];
  return html`<div class="empty">
    <div style="font-size:40px">🏢</div>
    <h2>${team ? t('{name}이(가) 출근했어', { name: team.name }) : t('{name}와 대화', { name: agent?.name || t('에이전트') })}</h2>
    <div>${team ? team.stages.map((st, i) => html`${i ? ' → ' : ''}<b>${st.label}</b>(${st.agentIds.map((id) => agentById(id)?.name).filter(Boolean).join('+')})`) : t('맨 위에서 팀이나 에이전트를 바꿀 수 있어.')}</div>
    <div class="small" style="margin-top:6px">${t('Ctrl+V로 이미지 붙여넣기')} · <b>@</b> ${t('특정 에이전트 지정')} · <b>/</b> ${t('스킬 실행')}</div>
    <div class="starters">${starters.map(([lbl, p]) => html`<div class="starter" onClick=${() => { state.ui.draft = p; changed(); }}><b>${lbl}</b>${p}</div>`)}</div>
  </div>`;
}

// ── 진행 바 + 승인/오류 카드 ──
function RunBar({ s, run }) {
  const active = run && ['running', 'paused', 'waiting'].includes(run.status) && !run.endedAt;
  const u = sessionUsage(s);
  const usageText = `${u.estimated ? '~' : ''}${t('{n} 토큰', { n: fmtTok(usageTotal(u)) })} ${fmtCost(u.cost)}`;
  if (!run) return html`<div class="runbar"><span class="muted small">${t('아직 실행 없음')}</span><span class="grow"></span><${MemoryBadge} s=${s} /><span class="small muted">${t('세션 사용량 {usage}', { usage: usageText })}</span></div>`;
  const ctl = (action) => post(`/api/sessions/${s.id}/control`, { action }).catch((e) => toast(e.message, 'error'));
  return html`<div class="runbar">
    <div class="stages">
      ${run.stages.map((st, i) => html`${i > 0 && html`<span class="stage-arrow">→</span>`}<span class=${`stage ${st.status}`} title=${`${st.agentIds.map((id) => agentById(id)?.name).join(', ')}${st.note ? ` · ${st.note}` : ''}`}>
        ${st.status === 'running' ? html`<span class="spin" style="width:10px;height:10px"></span>` : st.status === 'done' ? '✓' : st.status === 'error' ? '⚠' : st.status === 'review' ? '✋' : st.status === 'skipped' ? '⤼' : `${i + 1}`}
        ${st.label}${st.agentIds.length > 1 ? ` ×${st.agentIds.length}` : ''}${st.meetingNow ? ` · ${meetLabel(st.meetingNow)}` : st.meeting ? ` · ${t('회의')}` : ''}${st.status === 'skipped' ? ` (${t('건너뜀')})` : st.note ? ` (${st.note})` : ''}
      </span>`)}
      ${!active && html`<span class=${`chip ${run.status === 'done' ? 'ok' : run.status === 'error' ? 'err' : 'warn'}`} style="margin-left:6px">${{ done: t('완료'), error: t('오류'), stopped: t('중지됨') }[run.status] || run.status}</span>`}
    </div>
    <${MemoryBadge} s=${s} />
    <span class="small muted hide-sm" title=${u.estimated ? t('작성 중인 출력은 글자 수로 추정(~)') : ''}>${t('세션 {usage}', { usage: usageText })}</span>
    ${active && run.stages[run.stageIndex]?.meetingNow && run.stages[run.stageIndex].meetingNow.phase !== 'conclude' && html`<button class="btn sm" onClick=${() => ctl('conclude')} title=${t('지금까지 나온 의견으로 진행자가 바로 결론을 내')}>${t('회의 끝내기')}</button>`}
    ${active && html`
      ${run.status === 'paused' || run.pauseRequested
        ? html`<button class="btn sm" onClick=${() => ctl('resume')} title=${t('다시 진행')}><${Icon} name="play" /> ${t('재개')}</button>`
        : html`<button class="btn sm" onClick=${() => ctl('pause')} title=${t('지금 단계가 끝나면 멈춤')}><${Icon} name="pause" /> ${t('일시정지')}</button>`}
      <button class="btn sm danger" onClick=${() => ctl('stop')} title=${t('모든 에이전트 즉시 중지')}><${Icon} name="stop" /> ${t('중지')}</button>`}
  </div>`;
}

function Gate({ s, run }) {
  const [text, setText] = useState('');
  if (!run || run.endedAt) return null;
  const hold = run.hold;
  const ctl = (action, txt) => post(`/api/sessions/${s.id}/control`, { action, text: txt }).then(() => setText('')).catch((e) => toast(e.message, 'error'));
  if (run.status === 'paused') {
    return html`<div class="gate"><b>⏸ ${t('일시정지됨')}</b><div class="small">${t('다음 단계 전에 멈춰 있어. 지시를 추가하거나 재개해.')}</div>
      <div class="row"><button class="btn primary sm" onClick=${() => ctl('resume')}><${Icon} name="play" /> ${t('재개')}</button><button class="btn sm danger" onClick=${() => ctl('stop')}>${t('중지')}</button></div></div>`;
  }
  if (run.status !== 'waiting' || !hold) return null;
  const st = run.stages[hold.stageIndex];
  if (hold.reason === 'approve') {
    const next = run.stages[hold.stageIndex + 1];
    return html`<div class="gate">
      <b>✋ ${t('승인 필요 — "{label}" 단계 결과를 확인해줘', { label: st.label })}</b>
      <div class="small">${next ? t('승인하면 "{label}" 단계({names})로 넘어가.', { label: next.label, names: next.agentIds.map((id) => agentById(id)?.name).join(', ') }) : t('승인하면 작업을 마쳐.')}</div>
      <textarea class="textarea" style="min-height:52px" placeholder=${t("고칠 점이 있으면 적고 '수정 요청'을 눌러 (같은 단계를 다시 실행)")} value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
      <div class="row">
        <button class="btn ok sm" onClick=${() => ctl('approve')}><${Icon} name="check" /> ${t('승인하고 계속')}</button>
        <button class="btn sm" disabled=${!text.trim()} onClick=${() => ctl('reject', text)}><${Icon} name="edit" /> ${t('수정 요청')}</button>
        <span class="grow"></span>
        <button class="btn sm danger" onClick=${() => ctl('stop')}>${t('여기서 중지')}</button>
      </div>
    </div>`;
  }
  return html`<div class="gate err">
    <b>⚠ ${t('"{label}" 단계에서 오류가 났어', { label: st.label })}</b>
    <div class="small mono" style="white-space:pre-wrap">${hold.message}</div>
    <textarea class="textarea" style="min-height:44px" placeholder=${t('(선택) 다시 시도할 때 덧붙일 지시')} value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
    <div class="row">
      <button class="btn primary sm" onClick=${() => ctl('retry', text)}><${Icon} name="refresh" /> ${t('다시 시도')}</button>
      <button class="btn sm" onClick=${() => ctl('skip')}><${Icon} name="skip" /> ${t('건너뛰고 계속')}</button>
      <span class="grow"></span>
      <button class="btn sm danger" onClick=${() => ctl('stop')}>${t('중지')}</button>
    </div>
  </div>`;
}

// ── 입력창 ──
function Composer({ s, run }) {
  const [text, setText] = useState('');
  const [atts, setAtts] = useState([]);
  const [mention, setMention] = useState(null);
  const [mode, setMode] = useState('steer');
  const [pop, setPop] = useState(null); // {kind:'@'|'/', q, idx}
  const [drag, setDrag] = useState(false);
  const ta = useRef(null);
  const fileIn = useRef(null);
  const active = run && ['running', 'paused', 'waiting'].includes(run.status) && !run.endedAt;

  useEffect(() => { if (state.ui.draft) { setText(state.ui.draft); state.ui.draft = null; setTimeout(() => ta.current?.focus(), 0); } });
  // 우클릭 메뉴의 '지시하기': 받는 에이전트를 정하고 입력칸으로 간다
  useEffect(() => { if (state.ui.mentionTo) { setMention(state.ui.mentionTo); state.ui.mentionTo = null; setTimeout(() => ta.current?.focus(), 0); } });
  useEffect(() => { setAtts([]); setMention(null); }, [s.id]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(260, el.scrollHeight)}px`;
  }, [text]);

  const addFiles = async (files) => {
    for (const f of files) {
      if (f.size > 30 * 1024 * 1024) { toast(t('{name}: 30MB 넘는 파일은 못 올려', { name: f.name }), 'error'); continue; }
      const tmp = { tmp: Math.random().toString(36).slice(2), name: f.name || t('붙여넣은 이미지.png'), mime: f.type, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
      setAtts((x) => [...x, tmp]);
      try {
        const meta = await upload(f);
        setAtts((x) => x.map((a) => (a.tmp === tmp.tmp ? { ...meta, preview: tmp.preview } : a)));
      } catch (e) {
        toast(e.message, 'error');
        setAtts((x) => x.filter((a) => a.tmp !== tmp.tmp));
      }
    }
  };

  const items = useMemo(() => {
    if (!pop) return [];
    const q = pop.q.toLowerCase();
    if (pop.kind === '@') return state.agents.filter((a) => !q || a.name.toLowerCase().includes(q) || (a.role || '').includes(q)).slice(0, 12).map((a) => ({ id: a.id, label: a.name, desc: `${a.role || ''} · ${a.model || ''}`, agent: a }));
    return state.skills.filter((k) => !q || k.name.toLowerCase().includes(q)).slice(0, 30).map((k) => ({ id: k.id, label: `/${k.name}`, desc: k.description, skill: k }));
  }, [pop?.kind, pop?.q, state.agents, state.skills]);

  const onInput = (e) => {
    const v = e.target.value;
    setText(v);
    const pos = e.target.selectionStart;
    const before = v.slice(0, pos);
    const m = before.match(/(^|\s)([@/])([^\s@/]*)$/);
    if (m && (m[2] === '@' || before.trim().startsWith('/'))) setPop({ kind: m[2], q: m[3], idx: 0 });
    else setPop(null);
  };

  const pick = (it) => {
    const el = ta.current;
    const pos = el.selectionStart;
    const before = text.slice(0, pos).replace(/([@/])([^\s@/]*)$/, '');
    if (pop.kind === '@') { setMention(it.id); setText(before + text.slice(pos)); }
    else setText(`${before}/${it.skill.name} ${text.slice(pos)}`);
    setPop(null);
    setTimeout(() => el.focus(), 0);
  };

  const submit = async () => {
    const v = text.trim();
    if (!v && !atts.length) return;
    if (atts.some((a) => a.tmp)) { toast(t('파일 올리는 중이야. 잠깐만'), 'warn'); return; }
    const body = { text: v, attachments: atts.map((a) => a.id), mention, mode: active ? mode : 'queue' };
    setText(''); setAtts([]); setMention(null); setPop(null);
    try {
      const r = await post(`/api/sessions/${s.id}/messages`, body);
      if (r.steered) toast(t('작업 중인 에이전트에게 지시를 전달했어'), 'ok', 1800);
      else if (r.queued) toast(t('대기열에 넣었어 — 지금 작업이 끝나면 실행돼'), 'info', 2200);
    } catch (e) {
      toast(e.message, 'error');
      setText(v);
    }
  };

  const onKey = (e) => {
    if (pop && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPop({ ...pop, idx: (pop.idx + 1) % items.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPop({ ...pop, idx: (pop.idx - 1 + items.length) % items.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[pop.idx]); return; }
      if (e.key === 'Escape') { setPop(null); return; }
    }
    const sendKey = state.settings.sendOnEnter !== false ? (e.key === 'Enter' && !e.shiftKey && !e.isComposing) : (e.key === 'Enter' && (e.ctrlKey || e.metaKey));
    if (sendKey) { e.preventDefault(); submit(); }
  };

  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  };

  const mAgent = mention ? agentById(mention) : null;
  const target = s.teamId ? teamById(s.teamId) : null;
  // 이번에 일할 에이전트 중 로그인·설치가 안 된 AI 경고
  const workers = mAgent ? [mAgent] : sessionAgents({ ...s, messages: [] });
  const notReady = workers.filter((a) => { const p = state.providers.find((x) => x.id === a.provider); return p && !p.checking && !p.loggedIn; });

  return html`<div class="composer-wrap">
    ${notReady.length > 0 && !active && html`<div class="warnbox" style="max-width:860px;margin:0 auto 8px">
      ⚠ ${notReady.map((a) => `${a.name}(${state.providers.find((p) => p.id === a.provider)?.label})`).join(', ')} — ${t('로그인(또는 API 키)이 필요해 보여.')}
      <a href="#" onClick=${(e) => { e.preventDefault(); state.ui.settingsTab = 'accounts'; import('../state.js').then((m) => m.go('settings')); }}>${t('AI 계정 확인')}</a>
    </div>`}
    <div class=${`composer${drag ? ' drag' : ''}`}
      onDragOver=${(e) => { e.preventDefault(); setDrag(true); }} onDragLeave=${() => setDrag(false)}
      onDrop=${(e) => { e.preventDefault(); setDrag(false); addFiles([...e.dataTransfer.files]); }}>
      ${pop && items.length > 0 && html`<div class="popup">
        <div class="hd">${pop.kind === '@' ? t('이 에이전트에게만 보내기') : t('스킬 실행')}</div>
        ${items.map((it, i) => html`<div class=${`it${i === pop.idx ? ' on' : ''}`} onMouseDown=${(e) => { e.preventDefault(); pick(it); }}>
          ${it.agent ? html`<${Avatar} agent=${it.agent} size=${26} />` : html`<${Icon} name="spark" />`}
          <div style="min-width:0"><div><b>${it.label}</b></div><div class="d">${it.desc}</div></div>
        </div>`)}
      </div>`}
      ${atts.length > 0 && html`<div class="atts">${atts.map((a) => html`<${AttThumb} a=${a} uploading=${!!a.tmp} onRemove=${() => setAtts((x) => x.filter((y) => y !== a))} />`)}</div>`}
      <textarea ref=${ta} rows="1" value=${text} onInput=${onInput} onKeyDown=${onKey} onPaste=${onPaste}
        placeholder=${active ? (mode === 'steer' ? t('작업 중인 에이전트에게 바로 지시하기… (Enter)') : t('대기열에 넣을 다음 요청… (Enter)')) : (target ? t('{name}에게 맡길 일을 적어줘 — 이미지 붙여넣기·@·/ 가능', { name: target.name }) : t('에이전트에게 맡길 일을 적어줘 — 이미지 붙여넣기·@·/ 가능'))}></textarea>
      <div class="composer-bar">
        <input type="file" multiple hidden ref=${fileIn} onChange=${(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
        <button class="icon-btn" title=${t('파일·이미지 첨부')} aria-label=${t('첨부')} onClick=${() => fileIn.current.click()}><${Icon} name="clip" /></button>
        <button class="icon-btn" title=${t('에이전트 지정(@)')} aria-label=${t('에이전트 지정')} onClick=${() => { setText((x) => `${x}${x && !x.endsWith(' ') ? ' ' : ''}@`); setPop({ kind: '@', q: '', idx: 0 }); ta.current.focus(); }}><${Icon} name="at" /></button>
        <button class="icon-btn" title=${t('스킬(/)')} aria-label=${t('스킬')} onClick=${() => { setText((x) => (x.startsWith('/') ? x : `/${x}`)); setPop({ kind: '/', q: '', idx: 0 }); ta.current.focus(); }}><${Icon} name="spark" /></button>
        ${mAgent && html`<span class="chip accent">@${mAgent.name}<span class="x" onClick=${() => setMention(null)}>✕</span></span>`}
        ${active && html`<div class="seg mode-chip" title=${t('작업 중에 보내는 메시지 처리 방법')}>
          <button class=${mode === 'steer' ? 'on' : ''} onClick=${() => setMode('steer')}>${t('지금 끼어들기')}</button>
          <button class=${mode === 'queue' ? 'on' : ''} onClick=${() => setMode('queue')}>${t('다음 차례로')}</button>
        </div>`}
        <span class="grow"></span>
        <span class="kbd hide-sm">${state.settings.sendOnEnter !== false ? t('Enter 보내기 · Shift+Enter 줄바꿈') : t('Ctrl+Enter 보내기')}</span>
        ${active && !text.trim() && !atts.length
          ? html`<button class="send stop" title=${t('모두 중지')} aria-label=${t('중지')} onClick=${() => post(`/api/sessions/${s.id}/control`, { action: 'stop' }).catch((e) => toast(e.message, 'error'))}><${Icon} name="stop" /></button>`
          : html`<button class="send" title=${t('보내기')} aria-label=${t('보내기')} disabled=${!text.trim() && !atts.length} onClick=${submit}><${Icon} name="send" /></button>`}
      </div>
    </div>
  </div>`;
}

// ── 에이전트 상세(인스펙터) ──
function Inspector({ s, agentId }) {
  const a = agentById(agentId);
  const [note, setT] = useState('');
  if (!a) return null;
  const live = state.live[s.id]?.[agentId];
  const msgs = s.messages.filter((m) => m.agentId === agentId);
  const lastMsg = msgs[msgs.length - 1];
  const run = latestRun(s);
  const running = run && !run.endedAt && lastMsg?.status === 'streaming';
  const u = agentUsage(s, agentId);
  const close = () => { state.ui.inspector = null; changed(); };
  const ctl = (action, text) => post(`/api/sessions/${s.id}/control`, { action, agentId, text }).then(() => setT('')).catch((e) => toast(e.message, 'error'));
  const ask = async () => {
    const v = note.trim();
    if (!v) return;
    if (running) return ctl('steer', v);
    setT('');
    try { await post(`/api/sessions/${s.id}/messages`, { text: v, mention: agentId }); } catch (e) { toast(e.message, 'error'); }
    return undefined;
  };
  return html`<div class="drawer">
    <div class="drawer-head">
      <${Avatar} agent=${a} size=${40} />
      <div style="flex:1;min-width:0">
        <div style="font-weight:800">${a.name} <span class="muted small">${a.role}</span></div>
        <div class="row small" style="gap:6px;flex-wrap:wrap">${a.routing !== 'auto' && html`<${ProviderChip} id=${a.provider} />`}<span class="chip mono">${agentModelText(a, s)}</span></div>
      </div>
      <button class="icon-btn" title=${t('닫기')} onClick=${close}><${Icon} name="x" /></button>
    </div>
    <div class="drawer-body">
      <div class="row" style="margin-bottom:10px"><span class=${`sbadge ${live?.state || 'idle'}`}>${STATE_LABEL[live?.state || 'idle']}</span><span class="small muted ellipsis">${live?.detail || ''}</span></div>
      <div class="small muted" style="margin-bottom:10px">${t('이 세션 사용량: {tok} 토큰 {cost} · 메시지 {n}개', { tok: fmtTok(usageTotal(u)), cost: fmtCost(u.cost), n: msgs.length })}</div>
      ${lastMsg ? html`<${Message} m=${lastMsg} />` : html`<div class="muted">${t('아직 이 에이전트의 출력이 없어.')}</div>`}
    </div>
    <div class="drawer-foot">
      <textarea class="textarea" style="min-height:56px" placeholder=${running ? t('{name}에게 지금 바로 지시 (작업 중 끼어들기)', { name: a.name }) : t('{name}에게만 질문·요청 보내기', { name: a.name })} value=${note} onInput=${(e) => setT(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } }}></textarea>
      <div class="row">
        <button class="btn primary sm" disabled=${!note.trim()} onClick=${ask}><${Icon} name="send" /> ${running ? t('지시 보내기') : t('보내기')}</button>
        ${running && html`<button class="btn sm" onClick=${() => ctl('skip')} title=${t('이 에이전트만 멈추고 다음으로')}><${Icon} name="skip" /> ${t('건너뛰기')}</button>`}
        <span class="grow"></span>
        <button class="btn sm ghost" title=${t('이 화면을 떠나지 않고 모델·노력·권한을 바꿔')} onClick=${() => { state.ui.editAgent = a.id; changed(); }}><${Icon} name="gear" /> ${t('설정')}</button>
      </div>
    </div>
  </div>`;
}

// ── 오른쪽 패널 ──
export function RightPanel({ s }) {
  const [tab, setTab] = useState('team');
  const agents = sessionAgents(s);
  const live = state.live[s.id] || {};
  const lim = state.usage?.limits || {};
  const today = state.usage?.today || {};
  const u = sessionUsage(s);
  const L = (logs[s.id] || []).slice(-60).reverse();
  return html`<aside class="right">
    <div class="right-tabs seg" style="margin:10px 10px 4px">
      <button class=${tab === 'team' ? 'on' : ''} onClick=${() => setTab('team')}>${t('팀 현황')}</button>
      <button class=${tab === 'usage' ? 'on' : ''} onClick=${() => setTab('usage')}>${t('사용량·한도')}</button>
      <button class=${tab === 'log' ? 'on' : ''} onClick=${() => setTab('log')}>${t('활동 로그')}</button>
    </div>
    <div class="right-body">
      ${tab === 'team' && html`
        ${agents.map((a) => {
          const l = live[a.id];
          const au = agentUsage(s, a.id);
          return html`<div class=${`acard${state.ui.inspector === a.id ? ' on' : ''}`} data-agent=${a.id} onClick=${() => { state.ui.inspector = a.id; changed(); }}>
            <${Avatar} agent=${a} size=${38} />
            <div style="min-width:0">
              <div class="nm">${a.name}<span class=${`sbadge ${l?.state || 'idle'}`}>${STATE_LABEL[l?.state || 'idle']}</span></div>
              <div class="sub">${a.role} · ${agentModelText(a, s)}</div>
              <div class="detail">${l?.detail || ' '}</div>
              ${usageTotal(au) > 0 && html`<div class="sub">${t('{n} 토큰', { n: fmtTok(usageTotal(au)) })} ${fmtCost(au.cost)}</div>`}
            </div>
          </div>`;
        })}
        ${!agents.length && html`<div class="muted small">${t('이 세션에 배치된 에이전트가 없어.')}</div>`}`}
      ${tab === 'usage' && html`
        <div class="card"><h4>📊 ${t('이 세션')}</h4>
          <div class="stat"><span>${t('입력')}</span><span>${fmtTok(u.input)}</span></div>
          <div class="stat"><span>${t('출력')}</span><span>${fmtTok(u.output)}</span></div>
          <div class="stat"><span>${t('캐시 읽기/쓰기')}</span><span>${fmtTok(u.cacheRead)} / ${fmtTok(u.cacheWrite)}</span></div>
          <div class="stat"><span>${t('비용(추정, API 환산)')}</span><span>${fmtCost(u.cost) || '$0'}</span></div>
        </div>
        <div class="card"><h4>🔋 ${t('계정 한도')} <span class="small muted">${t('(실행할 때마다 갱신)')}</span></h4>
          <${Limits} lim=${lim} />
        </div>
        <div class="card"><h4>📅 ${t('오늘 (모든 세션)')}</h4>
          ${Object.entries(today).map(([p, v]) => html`<div class="stat"><span><${ProviderChip} id=${p} /></span><span>${t('{n} 토큰', { n: fmtTok(usageTotal(v)) })} ${fmtCost(v.cost)} · ${t('{n}회', { n: v.calls })}</span></div>`)}
          ${!Object.keys(today).length && html`<div class="muted small">${t('오늘 기록 없음')}</div>`}
        </div>`}
      ${tab === 'log' && html`<div class="log">
        ${L.map((x) => html`<div class="li"><span class="tm">${new Date(x.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).slice(-8)}</span><span><b>${agentById(x.agentId)?.name || x.agentId}</b> ${x.text}</span></div>`)}
        ${!L.length && html`<div class="muted small">${t('이 세션에서 아직 활동이 없어. (새로고침하면 초기화)')}</div>`}
      </div>`}
    </div>
  </aside>`;
}

const WIN_LABEL = tmap(() => ({ five_hour: t('5시간'), seven_day: t('주간'), primary: t('기본 창'), secondary: t('보조 창') }));
export function Limits({ lim }) {
  const entries = Object.entries(lim || {});
  if (!entries.length) return html`<div class="muted small">${t('아직 관측된 한도가 없어. Claude·Codex로 한 번 실행하면 표시돼.')}</div>`;
  return entries.map(([p, v]) => html`<div style="margin-bottom:6px">
    <div class="row" style="gap:6px"><${ProviderChip} id=${p} />${v.plan && html`<span class="chip">${v.plan}</span>`}<span class="small muted">${t('관측 {time}', { time: new Date(v.observedAt).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</span></div>
    ${Object.entries(v.windows || {}).map(([k, w]) => {
      const pct = w.pct ?? 0;
      return html`<div class="limit"><div class="lh"><span>${WIN_LABEL[k] || k}</span><b>${w.pct == null ? '?' : `${pct}%`}</b></div>
        <div class=${`bar${pct >= 90 ? ' high' : pct >= 60 ? ' mid' : ''}`}><i style=${`width:${Math.min(100, pct)}%`}></i></div>
        <div class="ls">${until(w.resetsAt)}</div></div>`;
    })}
  </div>`);
}
function until(sec) {
  if (!sec) return '';
  const d = sec * 1000 - Date.now();
  if (d <= 0) return t('초기화됨(다음 실행 때 갱신)');
  const h = Math.floor(d / 3600000);
  return h >= 24 ? t('{d}일 {h}시간 뒤 초기화', { d: Math.floor(h / 24), h: h % 24 }) : t('{h}시간 {m}분 뒤 초기화', { h, m: Math.floor((d % 3600000) / 60000) });
}

// ── 상단 바 ──
function TopBar({ s }) {
  const [title, setTitle] = useState(s.title);
  const [pick, setPick] = useState(false);
  const [folder, setFolder] = useState(false);
  const [cwd, setCwd] = useState('');
  useEffect(() => setTitle(s.title), [s.id, s.title]);
  const saveCwd = async () => {
    try {
      await patch(`/api/sessions/${s.id}`, { cwd: cwd.trim() });
      await loadSession(s.id, true);
      setFolder(false);
      toast(t('작업 폴더를 바꿨어 — 다음 실행부터 적용돼'), 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };
  const team = s.teamId ? teamById(s.teamId) : null;
  const agent = !team ? agentById(s.agentId || state.settings.defaultAgentId) : null;
  const vm = state.settings.viewMode || 'split';
  const setView = (v) => { state.settings.viewMode = v; changed(); import('../api.js').then(({ put }) => put('/api/settings', { viewMode: v })).catch(() => {}); };
  const save = () => { if (title.trim() && title !== s.title) patch(`/api/sessions/${s.id}`, { title: title.trim() }).catch((e) => toast(e.message, 'error')); };
  const setTarget = async (x) => {
    setPick(false);
    try { await patch(`/api/sessions/${s.id}`, x.team ? { teamId: x.id, agentId: null } : { teamId: null, agentId: x.id }); await loadSession(s.id, true); } catch (e) { toast(e.message, 'error'); }
  };
  return html`<div class="top">
    <button class="icon-btn" title=${t('사이드바')} aria-label=${t('사이드바')} onClick=${() => { state.ui.side = !state.ui.side; changed(); }}><${Icon} name="sidebar" /></button>
    <input class="top-title" value=${title} onInput=${(e) => setTitle(e.target.value)} onBlur=${save} onKeyDown=${(e) => e.key === 'Enter' && e.target.blur()} aria-label=${t('세션 제목')} />
    <div class="target-pick">
      <button class="chip btnish" onClick=${() => setPick(!pick)} title=${t('이 세션에서 일할 팀(배치) 또는 에이전트')}>
        ${team ? html`<${Icon} name="users" size=${14} /> ${team.name}` : html`<${Icon} name="bot" size=${14} /> ${agent?.name || t('에이전트 선택')}`} <${Icon} name="down" size=${13} />
      </button>
      ${pick && html`<div class="popup" style="top:calc(100% + 6px);bottom:auto;left:0;width:340px" onMouseLeave=${() => setPick(false)}>
        <div class="hd">${t('팀 배치 (파이프라인)')}</div>
        ${state.teams.map((tm) => html`<div class=${`it${s.teamId === tm.id ? ' on' : ''}`} onClick=${() => setTarget({ team: true, id: tm.id })}><${Icon} name="users" /><div style="min-width:0"><b>${tm.name}</b><div class="d">${tm.stages.map((x) => x.label).join(' → ')}</div></div></div>`)}
        <div class="hd">${t('에이전트 한 명과 대화')}</div>
        ${state.agents.map((a) => html`<div class=${`it${!s.teamId && s.agentId === a.id ? ' on' : ''}`} onClick=${() => setTarget({ team: false, id: a.id })}><${Avatar} agent=${a} size=${24} /><div style="min-width:0"><b>${a.name}</b><div class="d">${a.role} · ${agentModelText(a)}</div></div></div>`)}
      </div>`}
    </div>
    <span class="grow"></span>
    <div class="seg hide-sm" role="tablist" aria-label=${t('화면 배치')}>
      <button class=${vm === 'chat' ? 'on' : ''} onClick=${() => setView('chat')} title=${t('채팅만')}><${Icon} name="msg" size=${14} /></button>
      <button class=${vm === 'split' ? 'on' : ''} onClick=${() => setView('split')} title=${t('사무실 + 채팅')}><${Icon} name="split" size=${14} /></button>
      <button class=${vm === 'office' ? 'on' : ''} onClick=${() => setView('office')} title=${t('사무실 크게')}><${Icon} name="building" size=${14} /></button>
    </div>
    <button class="icon-btn" title=${t('대화를 마크다운(.md)으로 내보내기')} onClick=${() => exportMarkdown(s)}><${Icon} name="download" /></button>
    <div class="target-pick">
      <button class=${`icon-btn${folder ? ' on' : ''}`} title=${t('작업 폴더: {path}', { path: s.cwd || s.cwdResolved || '' })} onClick=${() => { setFolder(!folder); setCwd(s.cwd || ''); }}><${Icon} name="folder" /></button>
      ${folder && html`<div class="popup" style="top:calc(100% + 6px);bottom:auto;left:auto;right:0;width:420px;padding:12px">
        <div class="hd" style="padding:0 0 6px">${t('이 세션의 작업 폴더 (에이전트가 파일을 읽고 만드는 곳)')}</div>
        <input class="input mono" value=${cwd} onInput=${(e) => setCwd(e.target.value)} placeholder=${s.cwdResolved || t('비우면 기본 폴더')} />
        <div class="small muted" style="margin:6px 0 8px">${state.settings.defaultCwd ? t('비우면 설정의 기본 폴더를 써. 이미 있는 폴더만 돼.') : t('비우면 세션 전용 폴더를 써. 이미 있는 폴더만 돼.')}</div>
        <div class="row">
          <button class="btn sm primary" onClick=${saveCwd}>${t('적용')}</button>
          <button class="btn sm" onClick=${() => post(`/api/sessions/${s.id}/open-folder`).catch((e) => toast(e.message, 'error'))}><${Icon} name="folder" /> ${t('탐색기에서 열기')}</button>
          <span style="flex:1"></span><button class="btn sm ghost" onClick=${() => setFolder(false)}>${t('닫기')}</button>
        </div>
      </div>`}
    </div>
    <button class=${`icon-btn${state.ui.right ? ' on' : ''}`} title=${t('오른쪽 패널(팀 현황·사용량)')} onClick=${() => { state.ui.right = !state.ui.right; localStorage.setItem('ui.right', state.ui.right ? '1' : '0'); changed(); }}><${Icon} name="panel" /></button>
  </div>`;
}

export function SessionView({ s }) {
  const run = latestRun(s);
  const vm = state.settings.viewMode || 'split';
  const setView = (v) => { state.settings.viewMode = v; changed(); import('../api.js').then(({ put }) => put('/api/settings', { viewMode: v })).catch(() => {}); };
  return html`<div class="session">
    <${TopBar} s=${s} />
    ${vm !== 'chat' && html`<${OfficePanel} s=${s} full=${vm === 'office'} onCollapse=${() => setView('chat')} />`}
    ${vm === 'chat' && html`<button class="office-reopen" onClick=${() => setView('split')}><${Icon} name="down" size=${14} /> ${t('사무실 펼치기')}</button>`}
    ${vm !== 'office' && html`<${Chat} s=${s} run=${run} />`}
    ${vm === 'office' && html`<${Gate} s=${s} run=${run} />`}
    <${RunBar} s=${s} run=${run} />
    <${Composer} s=${s} run=${run} />
    ${state.ui.inspector && html`<${Inspector} s=${s} agentId=${state.ui.inspector} />`}
  </div>`;
}
