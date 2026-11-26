// 세션 화면: 사무실(실시간) + 채팅 + 입력창 + 진행 바 + 승인/오류 카드 + 에이전트 상세
import { Component } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Icon, Avatar, ProviderChip, PROVIDER_SHORT, STATE_LABEL, EFFORT_LABEL, fmtTok, fmtCost, fmtDur, usageTotal, officeMod, agentModelText, PERM_LABEL, Toggle } from '../ui.js';
import { state, changed, toast, agentById, teamById, latestRun, onServerEvent, loadSession, uiLang } from '../state.js';
import { post, patch, upload, uploadUrl } from '../api.js';
import { renderMarkdown } from '../markdown.js';
import { t, getLang, locale, tmap } from '../i18n/index.js';
import { MemoryBadge } from './memory.js';
import { DraftChip } from './rolenotes.js';
import { continueList, findInMessages, hideAsks, hideCheck, hideGoal, hideReview, hideResearch, hidePlan, hideBlocked, routeTip, agentWrote, hideTeam } from '../chat-tools.js';
import { GoalCard, MissionLog, MissionGate, ReviewTable, CutBox, ResearchCard, PlanCard, ReportCard } from './mission.js';
import { TeamCard } from './teamdoc.js';
import { researcherOf, meetingView, boardCards } from '../office/meeting.js';
import { meetLabel, goalWait } from '../stage-model.js';
import { FlowStage, StageStrip } from './stage.js';
import { weighted, rawSum, cacheHit, usageBreakdown, windowPassed, ANSWER_KINDS } from '../usage-numbers.js';
import { recordAge } from '../mission-numbers.js';
import { BrowserTab, BrowserTabButton, browserUsed, ShotThumb } from './browser.js';

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
  let partial = false, subOld = 0, subW = 0;
  for (const m of s?.messages || []) {
    if (m.agentId !== agentId || !m.usage) continue;
    addUsage(u, m);
    partial ||= m.usage.partial === true;
    if (m.usage.subW !== undefined) subW += m.usage.subW || 0; else subOld += m.usage.sub || 0; // 환산 몫을 적지 않던 옛 답은 1:1 합으로 따로
  }
  return Object.assign(u, partial ? { partial } : {}, subOld ? { subOld } : {}, subW ? { subW } : {});
}
// Claude 사용량 도움말 줄: 하위 에이전트 몫이 빠졌을 수 있는지(partial), 주 에이전트 밖에서 쓴 양(하위 에이전트 등)을 얼마나 셌는지.
// 옆 숫자와 같은 환산(subW, 결정 0026). 환산 몫을 적지 않던 옛 답(sub 만 있음, 여럿을 더한 값은 subOld)은 1:1 합이라고 밝혀 따로
const treeTip = (u) => {
  const old = u.subOld ?? (u.subW === undefined ? u.sub : 0);
  return [u.partial && t('하위 에이전트가 쓴 양이 빠졌을 수 있어.'),
    u.subW > 0 && t('주 에이전트 밖에서 쓴 환산 {n} 토큰 포함(하위 에이전트 등)', { n: fmtTok(u.subW) }),
    old > 0 && t('주 에이전트 밖에서 쓴 {n} 토큰 포함(하위 에이전트 등, 네 값 1:1 합)', { n: fmtTok(old) })].filter(Boolean);
};
// 부분 집계 표시(*). 마우스 없이도 알 수 있게 도움말과 같은 글을 화면 낭독기 이름으로 단다
const partialMark = (u) => (u.partial ? html` <span role="img" aria-label=${treeTip(u).join(' ')}>*</span>` : '');
// 사용량 한 숫자는 환산(결정 0026: 새 입력 + 캐시 쓰기 + 출력 + 캐시 읽기÷10, 서버의 회의 사용량 상한과 같은 함수). 나눈 값과 1:1 합은 도움말에
export const usageTip = (u = {}) => [t('새 입력 {i} · 캐시 쓰기 {cw} · 캐시 읽기 {cr} · 출력 {o}', { i: fmtTok(u.input || 0), cw: fmtTok(u.cacheWrite || 0), cr: fmtTok(u.cacheRead || 0), o: fmtTok(u.output || 0) }),
  t('환산 = 새 입력 + 캐시 쓰기 + 출력 + 캐시 읽기÷10 (네 값을 1:1 로 더하면 {raw})', { raw: fmtTok(rawSum(u)) })].join('\n');
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

// 상태 칩 순서: 사람이 봐야 하는 것(승인 대기·오류·멈춤) → 일하는 중 → 쉬는 중. 칩이 많아 넘쳐도 중요한 것이 먼저 보인다
const CHIP_RANK = { waiting: 0, error: 0, paused: 1, idle: 3, offline: 3, done: 3 };
function chipOrder(agents, live) {
  return agents.map((a, i) => [a, live[a.id]?.state || 'idle', i]).sort((x, y) => ((CHIP_RANK[x[1]] ?? 2) - (CHIP_RANK[y[1]] ?? 2)) || (x[2] - y[2]));
}

// 지금 회의 중인 단계의 참석자(없으면 빈 목록). 마을에서 한자리에 모으는 데 쓴다
function meetingIds(s) {
  const r = latestRun(s);
  const st = r && !r.endedAt && r.stages[r.stageIndex];
  return st && st.meetingNow ? st.agentIds : [];
}
// 지금 진행 중인 회의의 진행 표시(run.stages[i].meetingNow)와 진행자. 회의 중이 아니면 now 가 null
function liveMeeting(s) {
  const r = latestRun(s);
  const st = r && !r.endedAt && r.stages[r.stageIndex];
  return { now: (st && st.meetingNow) || null, chairId: (st && ((st.meeting && st.meeting.chairId) || st.agentIds[0])) || null };
}
// 회의 차례 글에 붙은 질문(msg.check)의 상태 칩: [글, 칩 모양]
// low: 목표 실행에서 남은 호출이 상한의 4분의 1 아래라 회의 중 조사를 껐다(결정 0017)
const checkChip = (status) => ({ asked: [t('조사 중'), ''], answered: [t('조사해 옴'), ' ok'], 'no-researcher': [t('조사할 사람 없음'), ' warn'], over: [t('조사 상한'), ' warn'], low: [t('호출이 적어 조사 끔'), ' warn'], near: [t('한도 임박이라 조사 끔'), ' warn'], failed: [t('확인 못 함'), ' warn'] }[status] || [status, '']);

// ── 사무실 패널 ──
// 나눠 보기는 흐름 무대(views/stage.js), "사무실 크게"는 마을·스킨 그림. 컴포넌트가 달라서 보기를 바꾸면 마을은 새로 만들어지고 나올 때 치워진다
function OfficePanel({ s, full, onCollapse, onJump }) {
  return full ? html`<${VillagePanel} s=${s} onJump=${onJump} />` : html`<${FlowStage} s=${s} onCollapse=${onCollapse} />`;
}

// 마을·스킨 그림("사무실 크게" 보기에서 화면 가득)
function VillagePanel({ s, onJump }) {
  const host = useRef(null);
  const officeRef = useRef(null);
  const jumpRef = useRef(null); // 게시판 카드를 눌렀을 때 채팅에서 그 메시지로(그림은 한 번만 만들어서 최신 함수를 여기로 넘긴다)
  jumpRef.current = onJump;
  const boardSid = useRef(null); // 게시판을 마지막으로 채운 세션(세션이 바뀌면 "새 카드" 표시 없이 채운다)
  const agents = sessionAgents(s);
  const key = agents.map((a) => `${a.id}:${a.name}:${a.model}:${avatarKey(a.avatar)}`).join('|');
  const mod = officeMod.m;

  const meta = (a) => ({ id: a.id, name: a.name, role: a.role, model: agentModelText(a, state.sessionData[s.id]), color: providerColorOf(a), avatar: a.avatar || {} });
  const meetKey = meetingIds(s).join(',');
  // 회의 중 조사하러 간 사람(참석자가 아니어도): 그 동안 조사 자리로 간다
  const lm = liveMeeting(s);
  const errandId = researcherOf(lm.now) || '';
  // 그림의 회의 표시: 말하는 사람·반대편·바퀴와 단계
  const meetView = meetingView(lm.now, lm.chairId);
  const meetViewKey = JSON.stringify(meetView);

  useEffect(() => {
    if (!mod || !host.current) return undefined;
    const office = mod.createOffice(host.current, {
      skin: skinValue(), reducedMotion: !!state.settings.reducedMotion, lang: uiLang(), quality: state.settings.officeQuality || 'full',
      onSelect: (id) => { state.ui.inspector = id; changed(); },
      onCard: (id) => jumpRef.current?.(id),
    });
    officeRef.current = office;
    boardSid.current = null;
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
      o.setState(a.id, { state: l?.state || 'idle', text: l?.detail || '', tool: l?.tool || null, tokens: usageTotal(u), badge: badgeFor(a, u), meeting: meetKey.split(',').includes(a.id), errand: a.id === errandId ? 'search' : null });
    }
  }, [key, s.id, mod, meetKey, errandId]);
  useEffect(() => { officeRef.current?.setMeeting?.(meetView); }, [meetViewKey, mod]);
  // 회의 결론 게시판: 이 세션의 최근 결론 3개(새것부터)
  const cards = boardCards(s.messages);
  const cardsKey = JSON.stringify(cards);
  useEffect(() => {
    const o = officeRef.current;
    if (!o?.setBoard) return;
    o.setBoard(cards, { quiet: boardSid.current !== s.id });
    boardSid.current = s.id;
  }, [cardsKey, s.id, mod]);

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
      const cur = state.sessionData[s.id] || s;
      o.setState(d.agentId, { state: d.state, text: d.detail, tool: d.tool, tokens: usageTotal(u), badge: a ? badgeFor(a, u) : '', meeting: meetingIds(cur).includes(d.agentId), errand: researcherOf(liveMeeting(cur).now) === d.agentId ? 'search' : null });
      // 도우미는 Task/Agent 도구가 실행 중이거나(끝나면 state 가 thinking 으로 바뀜) 하위 도구(↳)가 도는 동안만 머문다
      const tool = d.tool || '';
      const keep = (/^(Task|Agent)$/i.test(tool) && !['thinking', 'done', 'error', 'paused', 'idle'].includes(d.state)) || tool.startsWith('↳');
      const hid = helpers.current.get(d.agentId);
      if (keep && !hid && o.spawnHelper) helpers.current.set(d.agentId, o.spawnHelper(d.agentId, { label: t('서브에이전트') }));
      else if (!keep && hid) { helpers.current.delete(d.agentId); o.dismissHelper?.(hid); }
    } else if (type === 'handoff') o.handoff(d.from, d.to, d.label);
  }), [s.id, key, mod]);
  useEffect(() => () => helpers.current.clear(), [s.id, mod]);

  return html`<div class="office-wrap full">
    ${!mod && html`<div class="empty">${t('사무실 그래픽을 불러오는 중…')}</div>`}
    <div class="office-host" ref=${host}></div>
    <div class="office-tools">
      <select class="select" style="width:auto;padding:4px 8px;font-size:12px" value=${state.settings.skin} onChange=${(e) => setSkin(e.target.value)} title=${t('사무실 스킨')}>
        ${(mod?.SKINS || []).map((k) => html`<option value=${k.id}>${mod.skinName ? mod.skinName(k, uiLang()) : k.name}</option>`)}
        ${state.skins.map((k) => html`<option value=${k.id}>${k.type === 'village' ? '🏡' : '🖼'} ${k.name}</option>`)}
      </select>
    </div>
    ${agents.length > 0 && html`<div class="office-chips" role="group" aria-label=${t('에이전트 상태')}>
      ${chipOrder(agents, state.live[s.id] || {}).map(([a, st]) => { const label = STATE_LABEL[st] || st; return html`<button type="button" class=${`ochip st-${st}${state.ui.inspector === a.id ? ' on' : ''}`} aria-pressed=${state.ui.inspector === a.id ? 'true' : 'false'} aria-label=${`${a.name}, ${label}`} title=${`${a.name}${a.role ? ` · ${a.role}` : ''} · ${label}`} onClick=${() => { state.ui.inspector = a.id; changed(); }}><${Avatar} agent=${a} size=${18} /><b>${a.name}</b><span>${label}</span></button>`; })}
    </div>`}
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

// 인수인계 메모 요청: AI를 한 번 부르는 일이라 먼저 묻는다
async function askHandoff(sid) {
  if (!window.confirm(t('이 세션을 맡던 AI에게 인수인계 메모를 쓰게 할까? AI를 한 번 부르니까 사용량이 들어.'))) return;
  try { await post(`/api/sessions/${sid}/handoff`, {}); } catch (e) { toast(e.message, 'error'); }
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
    } else if (m.text) lines.push(`*${m.text}*`, ''); // 영입 제안 카드처럼 글이 없는 것은 내보내지 않는다
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${s.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'session'}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── 영입 제안 카드 ──
// "에이전트 한 명 더 영입해" 같은 말에 서버가 낸 초안. 영입을 눌러야 에이전트가 생긴다
function HireCard({ m }) {
  const sid = state.route.id;
  const [name, setName] = useState(m.draft?.name || '');
  const [role, setRole] = useState(m.draft?.role || '');
  const [add, setAdd] = useState(true);
  const [busy, setBusy] = useState(false);
  const base = agentById(m.draft?.baseId);
  const team = m.target ? teamById(m.target.teamId) : null;
  const stage = team?.stages.find((x) => x.id === m.target.stageId) || null;
  const full = !!stage && stage.agentIds.length >= 8;
  const perm = base ? (PERM_LABEL[base.permission]?.[0] || base.permission) : '';
  const hire = () => act('accept', { name, role, addToStage: !!stage && !full && add });
  const onEnter = (e) => { if (e.key === 'Enter' && !e.isComposing && base && name.trim()) { e.preventDefault(); hire(); } };
  const act = async (action, body = {}) => {
    if (busy) return;
    setBusy(true);
    try { await post(`/api/sessions/${sid}/proposals/${m.id}`, { action, ...body }); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  if (m.status === 'accepted') {
    const a = agentById(m.hiredAgentId);
    return html`<div class="msg proposal"><div class="hire done" role="status">
      <b>✓ ${t('{name} 영입 완료', { name: a?.name || m.draft?.name || '' })}</b>
      <span class="small muted">${m.placed ? t('"{team}" 팀의 "{stage}" 단계에 넣었어. 다음 실행부터 같이 일해.', { team: m.placed.teamName, stage: m.placed.stageLabel })
        : m.notPlaced === 'full' ? t('그 단계가 이미 꽉 차서(8명) 팀에는 넣지 못했어. 팀 배치에서 자리를 내고 넣어줘.')
        : m.notPlaced === 'gone' ? t('그 팀이나 단계가 그사이 지워져서 팀에는 넣지 못했어.')
        : t('팀에는 넣지 않았어. @이름으로 부르거나 팀 배치에서 넣을 수 있어.')}</span>
      ${a && html`<button class="btn sm" onClick=${() => { state.ui.editAgent = a.id; changed(); }}><${Icon} name="gear" /> ${t('설정 열기')}</button>`}
    </div></div>`;
  }
  if (m.status !== 'open') return html`<div class="msg system"><span role="status">${m.status === 'sent' ? t('영입 제안 대신 그 말을 그대로 보냈어.') : t('영입 제안을 취소했어.')}</span></div>`;
  return html`<div class="msg proposal"><div class="hire" role="group" aria-label=${t('에이전트 영입 제안')}>
    <div class="hire-head"><b>${t('에이전트 영입 제안')}</b><span class="small muted">${t('영입을 눌러야 만들어져. 아직 아무것도 바뀌지 않았어.')}</span></div>
    <div class="hire-fields">
      <label>${t('이름')}<input class="input" value=${name} maxlength="36" onInput=${(e) => setName(e.target.value)} onKeyDown=${onEnter} /></label>
      <label>${t('역할')}<input class="input" value=${role} maxlength="30" onInput=${(e) => setRole(e.target.value)} onKeyDown=${onEnter} /></label>
    </div>
    <div class="small">${base ? t('"{base}"와 같은 설정으로 만들어: {model} · 권한 {perm}. 지침·스킬·커넥터도 같아.', { base: base.name, model: agentModelText(base, state.sessionData[sid]), perm }) : t('본뜰 에이전트가 지워졌어. 에이전트 화면에서 직접 만들어줘.')}</div>
    ${stage && !full
      ? html`<label class="hire-check"><input type="checkbox" checked=${add} onChange=${(e) => setAdd(e.target.checked)} /> <span>${t('"{team}" 팀의 "{stage}" 단계에 함께 넣기', { team: team.name, stage: stage.label })} <span class="muted">${t('(이 팀을 쓰는 다른 세션에도 적용돼)')}${stage.meeting ? ` ${t('회의 단계라 참석자가 늘면 AI를 부르는 횟수도 늘어.')}` : ''}</span></span></label>`
      : html`<div class="small muted">${full ? t('"{stage}" 단계가 이미 꽉 차서(8명) 팀에는 넣지 않아. 영입한 뒤 팀 배치에서 자리를 내고 넣을 수 있어.', { stage: stage.label }) : t('팀에는 넣지 않아. 영입한 뒤 @이름으로 부르거나 팀 배치에서 넣을 수 있어.')}</div>`}
    <div class="hire-acts">
      <button class="btn primary sm" disabled=${busy || !base || !name.trim()} onClick=${hire}><${Icon} name="plus" /> ${t('영입')}</button>
      <button class="btn sm" disabled=${busy} onClick=${() => act('dismiss')}>${t('취소')}</button>
      <span class="grow"></span>
      <button class="btn ghost sm" disabled=${busy} title=${t('영입해 달라는 말이 아니었으면, 이 말을 그대로 에이전트에게 보내')} onClick=${() => act('send')}>${t('영입이 아니야 — 그대로 보내기')}</button>
    </div>
  </div></div>`;
}

// ── 메시지 ──
// 에이전트의 질문 창: 입력창 바로 위에 뜬다. 보기를 한 번 누르거나 숫자 키로 고르면 바로 답한다.
// 질문이 여럿이면 하나씩 보여 주고, 마지막 답에서 한꺼번에 보낸다. 접어 두면 한 줄로 남는다
function AskPanel({ s }) {
  const open = [];
  for (const m of s.messages) for (const x of m.asks || []) if (x.status === 'open') open.push({ ask: x, agent: agentById(m.agentId) });
  const cur = open[0];
  const id = cur ? cur.ask.id : null;
  const blank = { id, i: 0, ans: [], sel: [], other: '', busy: false, closed: false };
  const [st, setSt] = useState(blank);
  const v = st.id === id ? st : blank; // 다른 질문으로 바뀌면 처음부터(접어 뒀어도 새 질문은 펼친다)
  const n = cur ? cur.ask.questions.length : 0;
  const q = cur ? cur.ask.questions[Math.min(v.i, n - 1)] : null;
  // 키를 빠르게 연달아 눌러도 앞의 선택을 잃지 않게, 손잡이들은 화면에 그려진 값이 아니라 가장 최근 값을 본다
  const live = useRef(v);
  live.current = v;
  const set = (patch) => { const next = { ...live.current, ...patch }; live.current = next; setSt(next); };
  const unlock = () => { if (live.current.id === id) live.current = { ...live.current, busy: false }; setSt((x) => (x.id === id ? { ...x, busy: false } : x)); };
  const post1 = (body, patch) => {
    set({ ...patch, busy: true });
    post(`/api/sessions/${s.id}/control`, { action: 'answer', askId: id, ...body })
      // 성공하면 질문이 사라질 때까지 잠근 채로 둔다(그 틈에 숫자 키가 또 먹히지 않게). 실패했을 때만 다시 고칠 수 있게 푼다
      .then((r) => { if (r?.ok === false) { toast(r.reason || t('이미 답했거나 끝난 질문이야.'), 'warn'); unlock(); } })
      .catch((e) => { toast(e.message, 'error'); unlock(); });
  };
  // 이 질문의 답을 정한다: 다음 질문이 있으면 넘어가고, 마지막이면 보낸다
  const commit = (answer) => {
    const c = live.current;
    const ans = c.ans.slice();
    ans[c.i] = answer;
    if (c.i + 1 < n) set({ ans, i: c.i + 1, sel: [], other: '' });
    else post1({ answers: ans }, { ans });
  };
  const pick = (k) => {
    const c = live.current;
    const now = cur ? cur.ask.questions[c.i] : null;
    if (c.busy || c.closed || !now || k < 0 || k >= now.options.length) return;
    if (now.multi) set({ sel: c.sel.includes(k) ? c.sel.filter((x) => x !== k) : [...c.sel, k] });
    else commit({ picked: [k], other: '' });
  };
  const typed = v.other.trim();
  const canSend = !!q && !v.busy && (!!typed || (q.multi && v.sel.length > 0));
  const sendTyped = () => {
    const c = live.current;
    const now = cur ? cur.ask.questions[c.i] : null;
    const text = c.other.trim();
    if (!now || c.busy || !(text || (now.multi && c.sel.length))) return;
    commit({ picked: now.multi ? c.sel : [], other: text });
  };
  // 숫자 키로 고르기: 글을 쓰는 중(입력칸)이거나 다른 창이 떠 있으면 건드리지 않는다
  useEffect(() => {
    if (!cur || v.closed) return undefined;
    const onKey = (e) => {
      // 키를 누르고 있어도 질문이 연달아 넘어가지 않게, 다른 창이나 우클릭 메뉴가 떠 있으면 그쪽 키로 둔다
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat || e.defaultPrevented) return;
      const el = e.target;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (document.querySelector('.backdrop, .ctx-menu, [role="dialog"], [role="menu"]')) return;
      if (!/^[1-9]$/.test(e.key)) return;
      e.preventDefault();
      pick(Number(e.key) - 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  if (!cur) return null;
  const who = cur.agent ? cur.agent.name : t('에이전트');
  if (v.closed) {
    return html`<button type="button" class="ask-mini" onClick=${() => set({ closed: false })}>
      🙋 ${t('질문 {n}개가 답을 기다려', { n: open.length })} <b>${t('열기')}</b>
    </button>`;
  }
  return html`<div class="ask-panel" role="group" aria-label=${t('에이전트의 질문')}>
    <div class="ask-head">
      <span class="ask-who">🙋 ${t('{name}의 질문', { name: who })}${n > 1 ? html` <span class="chip">${v.i + 1}/${n}</span>` : ''}${open.length > 1 ? html` <span class="muted small">${t('뒤에 {n}개 더', { n: open.length - 1 })}</span>` : ''}</span>
      <button type="button" class="icon-btn" title=${t('접어 두기 (답은 나중에)')} aria-label=${t('접어 두기 (답은 나중에)')} onClick=${() => set({ closed: true })}>✕</button>
    </div>
    <div class="ask-question" aria-live="polite">${q.header && html`<span class="chip accent">${q.header}</span>`}<span>${q.question}</span>${q.multi && html`<span class="muted small">${t('여러 개 고를 수 있어')}</span>`}</div>
    <div class="ask-rows" role=${q.multi ? 'group' : 'radiogroup'} aria-label=${q.question}>
      ${q.options.map((o, k) => html`<button type="button" key=${`${v.i}-${k}`} class=${`ask-row${v.sel.includes(k) ? ' on' : ''}`} role=${q.multi ? 'checkbox' : 'radio'}
        aria-checked=${v.sel.includes(k) ? 'true' : 'false'} aria-label=${`${k + 1}. ${o.label}${o.description ? `. ${o.description}` : ''}`} disabled=${v.busy} onClick=${() => pick(k)}>
        <span class="ask-num" aria-hidden="true">${k + 1}</span>
        <span class="ask-row-text"><b>${o.label}</b>${o.description && html`<span>${o.description}</span>`}</span>
        ${!q.multi && html`<span class="ask-go" aria-hidden="true">→</span>`}
      </button>`)}
    </div>
    <div class="ask-foot">
      ${v.i > 0 && html`<button type="button" class="btn sm" disabled=${v.busy} onClick=${() => set({ i: v.i - 1, sel: [], other: '' })}>${t('이전')}</button>`}
      <input class="input" placeholder=${t('또는 직접 답을 써')} aria-label=${t('직접 쓰는 답')} maxlength="1000" value=${v.other} disabled=${v.busy}
        onInput=${(e) => set({ other: e.target.value })} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendTyped(); } }} />
      <button type="button" class="btn sm" disabled=${v.busy} title=${t('답하지 않고 넘겨. 에이전트가 가정을 정해서 진행해.')} onClick=${() => post1({ skip: true }, {})}>${t('건너뛰기')}</button>
      <button type="button" class="btn primary sm" disabled=${!canSend} onClick=${sendTyped}>${v.i + 1 < n ? t('다음') : t('보내기')}</button>
    </div>
  </div>`;
}

class Message extends Component {
  // 제안 카드는 에이전트·팀 목록도 보여 주므로 언제나 다시 그린다
  shouldComponentUpdate(np, ns) { return np.m.role === 'proposal' || np.m._v !== this.v || np.m !== this.props.m || np.compact !== this.props.compact || np.fold !== this.props.fold || ns.open !== this.state.open || getLang() !== this.lang; }
  render({ m, fold }, { open }) {
    this.v = m._v;
    this.lang = getLang();
    if (m.role === 'user' && m.handoffAsk) return html`<div class="msg system"><span>${t('인수인계 메모를 써 달라고 했어.')}</span></div>`;
    if (m.role === 'user') {
      const ag = m.mention ? agentById(m.mention) : null;
      return html`<div class="msg user"><div>
        <div class="bubble">
          ${m.attachments?.length ? html`<div class="att">${m.attachments.map((a) => html`<${AttThumb} a=${a} />`)}</div>` : ''}
          ${ag && html`<span class="mention">@${ag.name} </span>`}${m.text}
        </div>
        <div class="msg-foot meta" style="justify-content:flex-end">${m.status === 'queued' ? html`<span class="chip warn">${t('대기열 — 지금 작업 끝나면 실행')}</span>` : ''}${m.missionNote ? html`<span class="chip" title=${t('목표가 도는 동안 보낸 말이라 그 뒤에 시작하는 단계들에 추가 지시로 들어가')}>${t('추가 지시')}</span>` : ''}
          <span class="act">
            <button class="btn ghost sm" title=${t('입력창으로 가져와 고쳐 보내기')} onClick=${() => { state.ui.draft = m.text; changed(); }}><${Icon} name="edit" /> ${t('고쳐 쓰기')}</button>
            <button class="btn ghost sm" title=${t('같은 내용으로 다시 실행')} onClick=${() => resend(m)}><${Icon} name="refresh" /> ${t('다시 보내기')}</button>
          </span></div>
      </div></div>`;
    }
    if (m.role === 'proposal') return m.kind === 'goal' ? html`<${GoalCard} m=${m} />` : m.kind === 'research' ? html`<${ResearchCard} m=${m} />` : m.kind === 'plan' ? html`<${PlanCard} m=${m} />` : m.kind === 'team' ? html`<${TeamCard} m=${m} />` : m.kind === 'report' ? html`<${ReportCard} m=${m} />` : html`<${HireCard} m=${m} />`;
    if (m.role === 'system') return html`<div class="msg system"><span>${m.text}</span></div>`;
    const a = agentById(m.agentId) || { name: t('삭제된 에이전트'), emoji: '❔' };
    const streaming = m.status === 'streaming';
    const tools = m.blocks.filter((b) => b.kind === 'tool');
    const thinking = m.blocks.find((b) => b.kind === 'thinking');
    const notices = m.blocks.filter((b) => b.kind === 'notice' && !b.quiet);
    const quiet = m.blocks.filter((b) => b.kind === 'notice' && b.quiet);
    const u = m.usage || {};
    // 긴 답은 접어 둔다(앞부분만 보이고 '전체 보기'로 편다). 쓰는 중인 답과, 펼쳐 두기로 한 답(가장 최근 실행의 마지막 결과)은 펼친다
    this.seen ||= streaming; // 쓰는 걸 지켜본 답은 끝나도 접지 않는다(읽던 답이 갑자기 줄지 않게)
    const asks = (m.asks || []).filter((x) => x.status === 'open'); // 답은 입력창 위의 질문 창에서 한다
    // 질문 블록은 입력창 위의 질문 창으로, 회의 차례의 조사 질문 블록은 글 아래 "확인 필요" 줄로, 목표 카드 블록은 목표 카드로, 판정 블록은 기준표로,
    // 일하기 전 조사 질문 블록(결정 0017)은 글 아래 질문 목록으로 보여 준다
    // 일 카드의 계획 블록(결정 0018)은 계획 카드로, 일 단계 답 끝의 막힘 블록은 "막힘: 이유" 줄로 보여 준다
    const body = m.review ? hideReview(m.text, m.reviewBlock, streaming) : m.prep?.kind === 'questions' ? hideResearch(m.text, m.researchBlock, streaming)
      : m.prep?.kind === 'plan' ? hidePlan(m.text, m.planBlock, streaming) : m.prep?.kind === 'team' ? hideTeam(m.text, m.teamBlock, streaming) // 팀 초안 블록은 팀 제안 카드로(결정 0024)
        : hideBlocked(hideCheck(hideAsks(hideGoal(m.text, m.goalBlock, streaming), m.asks, streaming), m.check, streaming), m.blockedBlock, streaming);
    // 조사 결과: 누구의 어떤 질문에 답했는지(질문이 든 차례 글에서 찾는다)
    const asker = m.checkOf ? state.sessionData[state.currentId]?.messages.find((x) => x.id === m.checkOf) : null;
    // 배정 기록(결정 0022): 모델 칩에 마우스를 올리면 요청한 AI와 이유(모델을 기본값으로 둬서 모델 칩이 없으면 AI 칩에). 출처 표시: 목표 일 실행의 일 단계·일 카드 답과 회의 결론에 "에이전트가 씀"
    const tip = routeTip(m.route, { t, label: (p) => PROVIDER_SHORT[p] || p });
    const wrote = agentWrote(m, (state.sessionData[state.currentId]?.runs || []).find((r) => r.id === m.runId));
    const chip = m.check ? checkChip(m.check.status) : null;
    const long = !streaming && body.length > FOLD_CHARS;
    const folded = long && !(open ?? (!fold || this.seen));
    // 펼치고 접을 때: 대화가 맨 아래로 끌려가지 않게 알리고, 접은 뒤에는 버튼이 화면 밖으로 밀리지 않게 한다
    const toggle = (e) => {
      const btn = e.currentTarget;
      this.props.onToggle?.();
      this.setState({ open: folded }, () => { if (!folded) btn.scrollIntoView?.({ block: 'nearest' }); });
    };
    return html`<div class=${`msg agent${streaming ? ' streaming' : ''}`} data-agent=${m.agentId} data-mid=${m.id}>
      <${Avatar} agent=${a} />
      <div style="min-width:0">
        <div class="msg-head">
          <b>${a.name}</b>${m.stageLabel ? html`<span class="chip">${m.stageLabel}</span>` : ''}${m.meeting ? html`<span class=${`chip${m.meeting.phase === 'conclude' ? ' accent' : ''}`}>${meetLabel(m.meeting)}</span>` : ''}${m.meeting?.opposer ? html`<span class="chip">${t('반대편')}</span>` : ''}${m.verdict ? html`<span class=${`chip${m.verdict.verdict === 'agree' ? ' accent' : ''}`}>${m.verdict.verdict === 'agree' ? t('합의') : m.verdict.verdict === 'ask' ? t('사용자에게 물음') : t('계속')}</span>` : ''}${m.stall ? html`<span class="chip warn" title=${t('반대편을 뺀 참석자의 입장이 앞 바퀴와 그대로라서 판정 없이 결론을 냈어.')}>${t('정체로 결론')}</span>` : ''}${m.handoff ? html`<span class="chip accent">${t('인수인계 메모')}</span>` : ''}${m.goalDraft ? html`<span class="chip accent">${t('목표 초안')}</span>` : ''}${m.review ? (m.review.quota ? html`<span class="chip warn">${t('기준 판정 · 한도로 중단')}</span>` : html`<span class="chip accent">${t('기준 판정 {n}회차', { n: m.review.round || 1 })}</span>`) : ''}${m.review?.retried ? html`<span class="chip">${t('다시 요청')}</span>` : ''}${m.prep?.qid ? html`<span class="chip">${m.prep.qid}</span>` : ''}${m.prep?.retried ? html`<span class="chip">${t('다시 요청')}</span>` : ''}${m.once && !m.review ? html`<span class="chip" title=${m.freshMeet ? t('세션의 CLI 대화를 이어 가지 않고 새 대화로 한 번 돈 차례야(앞 대화가 긴 세션의 회의).') : t('세션의 CLI 대화를 이어 가지 않고 새 대화로 한 번 돈 차례야(목표의 조사·회의).')}>${t('새 대화')}</span>` : ''}${m.prep?.kind === 'plan' ? html`<span class="chip accent">${t('일 계획')}</span>` : ''}${m.card ? html`<span class="chip accent" title=${t('일 카드')}>${m.card.id}</span>` : ''}${m.cardTail ? html`<span class="chip">${t('끝의 두 칸 다시')}</span>` : ''}${m.flags ? html`<span class=${`chip${m.flags.suspect ? ' warn' : ''}`}>${t('지시처럼 보이는 줄 {n}개', { n: m.flags.suspect })}</span><span class=${`chip${m.flags.unsourced ? ' warn' : ''}`}>${t('출처 없는 줄 {n}개', { n: m.flags.unsourced })}</span>` : ''}${m.textOnly ? html`<span class="chip warn" title=${t('읽기 전용을 강제하는 장치가 없는 AI로 조사해서, 글 지시로만 묶였어.')}>${t('글 지시로만')}</span>` : ''}${m.noTools ? html`<span class="chip">${t('도구 없음')}</span>` : ''}
          <${ProviderChip} id=${m.provider} title=${m.model ? '' : tip} />
          ${m.model && html`<span class="chip mono" title=${tip || undefined}>${m.model}${m.effort ? ` · ${EFFORT_LABEL[m.effort] || m.effort}` : ''}</span>`}
          ${wrote && html`<span class="small muted">${t('에이전트가 씀 · 사용자 확인 안 함')}</span>`}
          ${streaming && html`<span class="spin"></span>`}
        </div>
        ${(thinking || tools.length) ? html`<div class="blocks">
          ${thinking && html`<details class="blk thinking"><summary><span class="st">💭</span><span class="nm">${t('생각')}</span><span class="arg">${thinking.text.slice(-120)}</span></summary><pre>${thinking.text}</pre></details>`}
          ${tools.length > 6 ? html`<details class="tools-group"><summary>${t('도구 {n}개 사용 (펼치기)', { n: tools.length })}</summary><div class="blocks">${tools.map((b) => html`<${ToolBlock} b=${b} />`)}</div></details>`
            : tools.map((b) => html`<${ToolBlock} b=${b} />`)}
        </div>` : ''}
        ${notices.map((b) => html`<div class="notice">${b.text}${b.count > 1 ? html` <span class="chip">×${b.count}</span>` : ''}</div>`)}
        ${asker?.check && html`<div class="msg-check"><span class="q">🔎 ${t('{name}의 질문', { name: agentById(asker.agentId)?.name || '?' })}: ${asker.check.question}</span></div>`}
        <div class=${`msg-body md${folded ? ' folded' : ''}`} id=${`body-${m.id}`} onFocusCapture=${folded ? () => { this.props.onToggle?.(); this.setState({ open: true }); } : undefined} dangerouslySetInnerHTML=${{ __html: body.trim() ? renderMarkdown(body) : (streaming && !asks.length ? `<p class="muted">${t('작업 중…')}</p>` : '') }}></div>
        ${m.review && !streaming && html`<${ReviewTable} r=${m.review} />`}
        ${m.blockedBlock?.reason && !streaming && html`<div class="warnbox" role="note">⛔ ${m.blockedBlock.accepted ? t('막힘(받아들여서 이 답은 빼고 진행): {reason}', { reason: m.blockedBlock.reason }) : t('막힘: {reason}', { reason: m.blockedBlock.reason })}</div>`}
        ${m.prep?.questions?.length > 0 && html`<div class="notice">🔎 ${t('조사 질문 {n}개 — 조사 담당이 질문마다 찾아 와.', { n: m.prep.questions.length })}<ol class="prep-qs">${m.prep.questions.map((q) => html`<li>${q}</li>`)}</ol></div>`}
        ${asks.length > 0 && html`<div class="notice">🙋 ${t('아래 질문 창에서 답해 줘.')}</div>`}
        ${chip && html`<div class="msg-check"><span class="q">🔎 ${t('확인 필요: {q}', { q: m.check.question })}</span><span class=${`chip${chip[1]}`}>${chip[0]}</span></div>`}
        ${long && html`<button class="fold-btn" aria-expanded=${!folded} aria-controls=${`body-${m.id}`} onClick=${toggle}>${folded ? t('전체 보기 ({n}자)', { n: body.length.toLocaleString(locale()) }) : t('접기')}</button>`}
        ${m.error && html`<div class="msg-err">⚠ ${m.error}</div>`}
        <div class="msg-foot">
          ${m.status === 'stopped' && html`<span class="chip warn">${t('중지됨')}</span>`}
          ${usageTotal(u) > 0 && html`<span title=${[usageTip(u), ...treeTip(u)].join('\n')}>${t('환산 {n} 토큰', { n: fmtTok(weighted(u)) })}${partialMark(u)}</span>`}
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
  </details>${b.shot && html`<${ShotThumb} b=${b} />`}`;
}

function AttThumb({ a, onRemove, uploading }) {
  const img = a.mime?.startsWith('image/');
  return html`<div class=${`att${uploading ? ' up' : ''}`} title=${a.name}>
    ${img ? html`<img src=${a.preview || uploadUrl(a.id)} alt=${a.name} />` : html`<div class="ic">📄</div>`}
    <span class="ellipsis" style="max-width:130px">${a.name}</span>
    ${onRemove && html`<button class="rm" title=${t('빼기')} onClick=${onRemove}>✕</button>`}
  </div>`;
}

const FOLD_CHARS = 2400; // 이보다 긴 답은 접을 수 있다
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
  const jump = useRef(null); // 가려고 하는 메시지 id(그려진 뒤에 그 자리로 간다)
  const [find, setFind] = useState(null); // null: 닫힘, { q, at }: 열림
  const hits = useMemo(() => (find ? findInMessages(s.messages, find.q) : []), [find?.q, s.messages.length, last?.text?.length]);
  // 메시지로 가기: 아직 안 그린 앞 메시지면 거기까지 그린 뒤에 간다. 맨 아래 따라가기는 멈춘다
  const goTo = (id) => {
    const i = s.messages.findIndex((m) => m.id === id);
    if (i < 0) return;
    stick.current = false;
    jump.current = id;
    if (i < hidden) setShown(s.messages.length - i + 2); else force((n) => n + 1); // 이미 그려져 있으면 다시 그리기만 해서 아래 effect 가 그 자리로 가게 한다
  };
  const [, force] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el && jump.current) {
      const node = el.querySelector(`[data-mid="${jump.current}"]`);
      jump.current = null; // 못 찾았어도 푼다(안 풀면 아래의 맨 아래 따라가기가 영영 안 돈다)
      if (node) {
        const bar = el.querySelector('.chat-top')?.offsetHeight || 0;
        el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - bar - 8;
        const target = node.firstElementChild;
        if (node.querySelector('.msg-body.folded')) node.querySelector('.fold-btn')?.click(); // 접힌 답이면 펼쳐서 찾은 글이 보이게
        if (target) { target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1600); }
        return;
      }
    }
    const h = run && !run.endedAt && run.status === 'waiting' && ['mission', 'cap', 'quota', 'limitcap'].includes(run.hold?.reason) ? run.hold : null; // 구독 한도 상한(결정 0026)도
    if (el && h && gateAt.current !== h.at) {
      gateAt.current = h.at;
      const g = stick.current ? el.querySelector('.chat-inner .mission-gate') : null;
      if (g) {
        const bar = el.querySelector('.chat-top')?.offsetHeight || 0;
        el.scrollTop += g.getBoundingClientRect().top - el.getBoundingClientRect().top - bar - 8;
        stick.current = false; // 창을 읽는 동안 맨 아래로 다시 끌어내리지 않는다
        return;
      }
    }
    if (el && grow.current) { el.scrollTop += el.scrollHeight - grow.current; grow.current = 0; }
    else if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => { setShown(CHAT_WINDOW); setFind(null); jump.current = null; stick.current = true; const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [s.id]);
  // 사무실 게시판의 결론 카드를 누르면 그 메시지로 간다(위의 세션 바뀜 처리 뒤에 둬야 갓 그린 채팅에서도 가려던 곳이 지워지지 않는다)
  useEffect(() => { const id = state.ui.jumpTo; if (!id) return; state.ui.jumpTo = null; goTo(id); });
  // Ctrl+F: 브라우저 찾기 대신 대화에서 찾기를 연다(브라우저 찾기는 화면에 그린 40개만 본다)
  useEffect(() => {
    const k = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || !(e.key?.toLowerCase() === 'f' || e.code === 'KeyF')) return;
      if (document.querySelector('.backdrop')) return; // 다른 창이 떠 있으면 그 뒤에서 열지 않는다
      if (document.activeElement?.closest?.('.chat-find')) return; // 이미 찾기 칸이면 한 번 더 누를 때 브라우저 찾기로 넘긴다
      e.preventDefault();
      setFind((f) => f || { q: '', at: -1 });
      ref.current?.querySelector('.chat-find input')?.focus(); // 이미 열려 있으면 바로
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  // 찾기 칸이 그려지는 즉시 포커스를 준다(그 전에 친 글자가 입력칸으로 새지 않게)
  const findOpen = !!find;
  useLayoutEffect(() => { if (findOpen) ref.current?.querySelector('.chat-find input')?.focus(); }, [findOpen]); // 그린 직후 바로(화면이 가려져 있어도 늦지 않게)
  const onScroll = (e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  // 펼쳐 둘 답: 가장 최근 실행의 마지막 단계 결과와 회의 결론, 그리고 대화의 맨 마지막 답. 나머지 긴 답은 접는다
  const lastRun = s.runs[s.runs.length - 1];
  const lastAgent = s.messages.findLast((m) => m.role === 'agent');
  const keepOpen = (m) => m === lastAgent || !!m.error
    || (lastRun && m.runId === lastRun.id && (m.meeting ? m.meeting.phase === 'conclude' : m.stageIndex === lastRun.stages.length - 1));
  const unstick = () => { stick.current = false; };
  const gateAt = useRef(null); // 마지막으로 머리를 보여 준 목표 대기(hold.at)
  // 내 요청 띠: 가장 최근에 보낸 내 말(답이 길어지면 금방 위로 밀려 안 보이니 대화 위에 붙여 둔다)
  const mine = s.messages.findLast((m) => m.role === 'user' && m.text && !m.handoffAsk && !m.hire && !m.missionNote); // 목표가 도는 동안 보낸 추가 지시는 원래 요청이 아니다
  const after = mine ? s.messages.length - 1 - s.messages.indexOf(mine) : 0;
  const step = (d) => {
    if (!hits.length) return;
    const from = find.at < 0 ? (d < 0 ? 0 : -1) : find.at; // 아직 안 갔으면 '다음'은 첫째, '이전'은 마지막
    const at = ((from + d) % hits.length + hits.length) % hits.length;
    setFind({ ...find, at });
    goTo(hits[at]);
  };
  const closeFind = () => { setFind(null); setTimeout(() => document.querySelector('.composer textarea, textarea[rows="1"]')?.focus(), 0); };
  const onFindKey = (e) => {
    if (e.isComposing) return; // 한글을 치다 Enter 로 글자를 확정하는 중
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
  };
  return html`<div class="chat" ref=${ref} onScroll=${onScroll}>
    ${(find || (mine && after > 0)) && html`<div class="chat-top">
      ${find && html`<div class="chat-find" role="search">
        <${Icon} name="search" size=${14} />
        <input class="input" placeholder=${t('대화에서 찾을 말')} aria-label=${t('대화에서 찾기')} value=${find.q}
          onInput=${(e) => setFind({ q: e.target.value, at: -1 })} onKeyDown=${onFindKey} />
        <span class="muted count" aria-live="polite">${find.q.trim() ? (hits.length ? t('{n}/{total}', { n: Math.max(0, find.at + 1), total: hits.length }) : t('없음')) : ''}</span>
        <button class="icon-btn" title=${t('이전 (Shift+Enter)')} aria-label=${t('이전')} disabled=${!hits.length} onClick=${() => step(-1)}><${Icon} name="up" size=${14} /></button>
        <button class="icon-btn" title=${t('다음 (Enter)')} aria-label=${t('다음')} disabled=${!hits.length} onClick=${() => step(1)}><${Icon} name="down" size=${14} /></button>
        <button class="icon-btn" title=${t('닫기 (Esc)')} aria-label=${t('닫기')} onClick=${closeFind}><${Icon} name="x" size=${14} /></button>
      </div>`}
      ${mine && after > 0 && html`<button class="my-ask" title=${t('내가 보낸 말로 가기')} onClick=${() => goTo(mine.id)}>
        <b>${t('내 요청')}</b><span class="txt">${mine.text.replace(/\s+/g, ' ').slice(0, 300)}</span><span class="muted when">${new Date(mine.createdAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span>
      </button>`}
    </div>`}
    <div class="chat-inner">
      ${hidden > 0 && html`<button class="chat-more" onClick=${showMore}>${t('이전 대화 {n}개 더 보기', { n: Math.min(hidden, CHAT_WINDOW) })} <span class="muted">${t('(남은 {n}개)', { n: hidden })}</span></button>`}
      ${s.messages.length === 0 ? html`<${Welcome} s=${s} />` : visible.map((m) => html`<div class="msg-wrap" key=${m.id} data-mid=${m.id}><${Message} m=${m} fold=${m.role === 'agent' && !keepOpen(m)} onToggle=${unstick} /></div>`)}
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

// 일 카드 단계(결정 0018)에 마우스를 올리면 그 단계의 카드 제목(그 목표의 카드일 때만)
const cardTitles = (s, run, st) => {
  if (st.mission !== 'cards' || !st.cardIds?.length || s.mission?.id !== run.missionId) return '';
  return '\n' + st.cardIds.map((id) => { const c = (s.mission.cards || []).find((x) => x.id === id); return c ? `${id} · ${c.title}` : id; }).join('\n');
};

// ── 진행 바 + 승인/오류 카드 ──
// stages: 단계 띠까지 그린다("사무실 크게" 보기). 나눠 보기·채팅만 보기에서는 단계를 위쪽 무대·접은 띠가 보여 주고, 이 줄은 단추·기억·사용량만
function RunBar({ s, run, stages = true }) {
  const active = run && ['running', 'paused', 'waiting'].includes(run.status) && !run.endedAt;
  const u = sessionUsage(s);
  const usageText = `${u.estimated ? '~' : ''}${t('환산 {n} 토큰', { n: fmtTok(weighted(u)) })} ${fmtCost(u.cost)}`;
  const cls = stages ? 'runbar' : 'runbar thin';
  if (!run) return html`<div class=${cls}>${stages && html`<span class="muted small">${t('아직 실행 없음')}</span>`}<span class="grow"></span><${MemoryBadge} s=${s} /><span class="small muted">${t('세션 사용량 {usage}', { usage: usageText })}</span></div>`;
  const ctl = (action) => post(`/api/sessions/${s.id}/control`, { action }).catch((e) => toast(e.message, 'error'));
  return html`<div class=${cls}>
    ${stages ? html`<div class="stages">
      ${run.stages.map((st, i) => { const wait = goalWait(run, i); return html`${i > 0 && html`<span class="stage-arrow">→</span>`}<span class=${`stage ${wait ? 'review' : st.status}`} title=${`${st.agentIds.map((id) => agentById(id)?.name).join(', ')}${st.note ? ` · ${st.note}` : ''}${cardTitles(s, run, st)}`}>
        ${wait ? wait : st.status === 'running' ? html`<span class="spin" style="width:10px;height:10px"></span>` : st.status === 'done' ? '✓' : st.status === 'error' ? '⚠' : st.status === 'review' ? '✋' : st.status === 'skipped' ? '⤼' : `${i + 1}`}
        ${st.label}${st.count ? ` ×${st.count}` : st.agentIds.length > 1 ? ` ×${st.agentIds.length}` : ''}${st.meetingNow ? ` · ${meetLabel(st.meetingNow)}` : st.meeting && st.mission !== 'meeting' ? ` · ${t('회의')}` : ''}${st.stall ? ` · ${t('정체')}` : ''}${st.status === 'skipped' ? ` (${t('건너뜀')})` : st.note ? ` (${st.note})` : ''}
      </span>`; })}
      ${!active && html`<span class=${`chip ${run.status === 'done' ? 'ok' : run.status === 'error' ? 'err' : 'warn'}`} style="margin-left:6px">${{ done: t('완료'), error: t('오류'), stopped: t('중지됨') }[run.status] || run.status}</span>`}
    </div>` : html`<span class="grow"></span>`}
    <${MemoryBadge} s=${s} />
    <span class="small muted hide-sm" title=${[usageTip(u), u.estimated ? t('작성 중인 출력은 글자 수로 추정(~)') : ''].filter(Boolean).join('\n')}>${t('세션 {usage}', { usage: usageText })}</span>
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
  // 목표의 판정 뒤 묻기·호출 상한(결정 0015)·한도 대기(결정 0019)는 질문 창 모양으로 따로 그린다
  if (hold.reason === 'mission' || hold.reason === 'cap' || hold.reason === 'quota' || hold.reason === 'limitcap') return html`<${MissionGate} s=${s} run=${run} key=${hold.at} />`; // 구독 한도 상한(결정 0026)도
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
  // 목표 모드(결정 0014): 세션마다 켜고 끈다. 켤 수 없으면 서버가 준 이유를 토글 옆에 보여 준다
  const [goalWhy, setGoalWhy] = useState('');
  const [goalKey, setGoalKey] = useState(0); // 바꾸지 못했을 때 스위치를 서버 값으로 다시 그린다
  const [goalBusy, setGoalBusy] = useState(false); // 켜기·끄기 요청 중에는 스위치를 잠근다
  const goalOn = !!s.goalMode;
  const working = s.mission && ['active', 'waiting'].includes(s.mission.status); // 이때 보낸 말(@이름 없이)은 그 뒤에 시작하는 단계들의 추가 지시가 된다
  const drafting = s.mission?.status === 'drafting' && active; // 이때 보낸 말(@이름 없이)은 모드와 상관없이 진행자에게 바로 들어간다
  const setGoal = async (on) => {
    if (goalBusy) return;
    setGoalBusy(true);
    try {
      await patch(`/api/sessions/${s.id}`, { goalMode: on });
      if (state.sessionData[s.id]) state.sessionData[s.id].goalMode = on;
      setGoalWhy('');
      changed();
    } catch (e) {
      setGoalWhy(e.message);
      setGoalKey((k) => k + 1);
    }
    setGoalBusy(false);
  };

  useEffect(() => { if (state.ui.draft) { setText(state.ui.draft); state.ui.draft = null; setTimeout(() => ta.current?.focus(), 0); } });
  // 우클릭 메뉴의 '지시하기': 받는 에이전트를 정하고 입력칸으로 간다
  useEffect(() => { if (state.ui.mentionTo) { setMention(state.ui.mentionTo); state.ui.mentionTo = null; setTimeout(() => ta.current?.focus(), 0); } });
  useEffect(() => { setAtts([]); setMention(null); setGoalWhy(''); }, [s.id]);
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
      else if (r.noted) toast(r.late ? t('추가 지시로 받았어. 다만 뒤에 시작할 단계가 없어서 이번 목표에는 반영되지 않을 수 있어') : t('그 뒤에 시작하는 단계들에 넣을 추가 지시로 받았어'), r.late ? 'warn' : 'ok', r.late ? 4000 : 2200);
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
    if (sendKey) { e.preventDefault(); submit(); return; }
    // 줄바꿈(보내기가 아닌 Enter): 번호·글머리 목록을 쓰던 중이면 다음 번호를 이어 준다
    if (e.key === 'Enter' && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const el = e.target;
      const next = continueList(el.value, el.selectionStart, el.selectionEnd);
      if (next) {
        e.preventDefault();
        // 브라우저의 입력 명령으로 넣는다(값을 통째로 바꾸면 Ctrl+Z 기록이 끊긴다). 안 되면 값을 바꾸는 방식으로
        let done = false;
        try {
          if (next.remove) { el.setSelectionRange(next.remove[0], next.remove[1]); done = document.execCommand('delete'); }
          else done = document.execCommand('insertText', false, next.insert);
        } catch { done = false; }
        if (!done || el.value !== next.text) {
          setText(next.text);
          requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = next.caret; });
        }
      }
    }
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
    <${AskPanel} s=${s} />
    ${s.mission?.status === 'cut' && html`<${CutBox} s=${s} m=${s.mission} compact=${true} />`}
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
        placeholder=${working && !mAgent ? t('그 뒤에 시작하는 단계들에 넣을 추가 지시… (Enter)') : drafting && goalOn && !mAgent ? t('목표 카드를 쓰는 진행자에게 바로 지시하기… (Enter)') : active ? (mode === 'steer' ? t('작업 중인 에이전트에게 바로 지시하기… (Enter)') : t('대기열에 넣을 다음 요청… (Enter)')) : goalOn && !mAgent ? t('목표로 만들 요청을 적어줘 — 진행자가 먼저 목표 카드를 써') : (target ? t('{name}에게 맡길 일을 적어줘 — 이미지 붙여넣기·@·/ 가능', { name: target.name }) : t('에이전트에게 맡길 일을 적어줘 — 이미지 붙여넣기·@·/ 가능'))}></textarea>
      <div class="composer-bar">
        <input type="file" multiple hidden ref=${fileIn} onChange=${(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
        <button class="icon-btn" title=${t('파일·이미지 첨부')} aria-label=${t('첨부')} onClick=${() => fileIn.current.click()}><${Icon} name="clip" /></button>
        <button class="icon-btn" title=${t('에이전트 지정(@)')} aria-label=${t('에이전트 지정')} onClick=${() => { setText((x) => `${x}${x && !x.endsWith(' ') ? ' ' : ''}@`); setPop({ kind: '@', q: '', idx: 0 }); ta.current.focus(); }}><${Icon} name="at" /></button>
        <button class="icon-btn" title=${t('스킬(/)')} aria-label=${t('스킬')} onClick=${() => { setText((x) => (x.startsWith('/') ? x : `/${x}`)); setPop({ kind: '/', q: '', idx: 0 }); ta.current.focus(); }}><${Icon} name="spark" /></button>
        <div class="row goal-toggle" title=${t('켜면 보낸 요청을 진행자가 먼저 목표 카드(목표·합격 기준)로 만들고, 네가 확인한 뒤에 팀이 그 목표를 들고 일해. @이름으로 보낸 말은 지금처럼 실행돼.')}>
          <${Toggle} key=${goalKey} checked=${goalOn} disabled=${goalBusy} title=${t('목표까지')} onChange=${setGoal} /><span class="small goal-word" aria-hidden="true" onClick=${() => { if (!goalBusy) setGoal(!goalOn); }}>${t('목표까지')}</span>
        </div>
        ${goalWhy && html`<span class="small muted goal-why" role="status">${goalWhy}</span>`}
        ${mAgent && html`<span class="chip accent">@${mAgent.name}<span class="x" onClick=${() => setMention(null)}>✕</span></span>`}
        ${active && !((working || (drafting && goalOn)) && !mAgent) && html`<div class="seg mode-chip" title=${t('작업 중에 보내는 메시지 처리 방법')}>
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
      <div class="small muted" style="margin-bottom:10px" title=${usageTip(u)}>${t('이 세션 사용량: 환산 {tok} 토큰 {cost} · 메시지 {n}개', { tok: fmtTok(weighted(u)), cost: fmtCost(u.cost), n: msgs.length })}</div>
      ${lastMsg ? html`<${Message} m=${lastMsg} panel=${true} />` : html`<div class="muted">${t('아직 이 에이전트의 출력이 없어.')}</div>`}
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

// 이 세션에서 어디에 썼는지(결정 0026): 메시지마다 이미 있는 사용량을 종류별(메시지의 표시로, 완주 보고와 같은 answerKind)·에이전트별로 묶는다(새로 저장하지 않는다).
// 목표가 있으면 그 목표의 답만(답에 단 목표 표시로) 볼 수 있다. "나눈 값 보기"를 켜면 줄마다 네 값을 보이는 줄로(키보드·화면 낭독기도 읽는다)
const USE_LABEL = () => ({ normal: t('보통 실행'), goal: t('목표 잡기'), research: t('조사'), meeting: t('회의'), plan: t('계획'), work: t('일 단계'), cards: t('일 카드'), review: t('검수'), team: t('팀 초안'), handoff: t('인수인계 메모') });
function UseBreakdown({ s }) {
  const [mine, setMine] = useState(false);
  const [parts, setParts] = useState(false);
  const m = s.mission;
  const runIds = m ? (s.runs || []).filter((r) => r.missionId === m.id).map((r) => r.id) : [];
  const has = !!m && (runIds.length > 0 || s.messages.some((x) => (x.missionId || x.card?.missionId) === m.id));
  const only = mine && has;
  const goalRuns = (s.runs || []).filter((r) => r.missionId).map((r) => r.id); // 목표 표시가 없던 옛 답을 일 단계로 알아볼 실행
  const b = usageBreakdown(s.messages, only ? { missionId: m.id, runIds, goalRuns } : { goalRuns });
  const L = USE_LABEL();
  const hit = (v) => { const h = cacheHit(v); return h === null ? '—' : `${Math.round(h * 100)}%`; };
  const split = (v) => t('새 입력 {i} · 캐시 쓰기 {cw} · 캐시 읽기 {cr} · 출력 {o}', { i: fmtTok(v.input || 0), cw: fmtTok(v.cacheWrite || 0), cr: fmtTok(v.cacheRead || 0), o: fmtTok(v.output || 0) });
  const row = (label, v, extra = null) => html`<tr title=${usageTip(v)}><td class="ellipsis">${label}</td><td class="num">${fmtTok(weighted(v))}</td>${extra !== null ? html`<td class="num">${extra}</td>` : ''}<td class="num">${v.n}</td></tr>
    ${parts && html`<tr class="use-parts"><td colspan=${extra !== null ? 4 : 3} class="small muted">${split(v)}</td></tr>`}`;
  return html`<div class="card use-card"><h4>🧾 ${t('어디에 썼는지')}</h4>
    <div class="row small" style="gap:12px;flex-wrap:wrap;margin-bottom:6px">
      ${has && html`<label class="row" style="gap:6px"><input type="checkbox" checked=${only} onChange=${(e) => setMine(e.target.checked)} />${t('이 목표 것만')}</label>`}
      ${b.total.n > 0 && html`<label class="row" style="gap:6px"><input type="checkbox" checked=${parts} onChange=${(e) => setParts(e.target.checked)} />${t('나눈 값 보기')}</label>`}
    </div>
    ${!b.total.n ? html`<div class="muted small">${t('아직 사용량이 없어.')}</div>` : html`
      <table class="use-table" aria-label=${t('종류별 사용량')}><thead><tr><th>${t('종류')}</th><th class="num">${t('환산')}</th><th class="num">${t('답')}</th></tr></thead>
        <tbody>${ANSWER_KINDS.filter((k) => b.kinds[k]).map((k) => row(L[k], b.kinds[k]))}</tbody></table>
      <table class="use-table" aria-label=${t('에이전트별 사용량')}><thead><tr><th>${t('에이전트')}</th><th class="num">${t('환산')}</th><th class="num" title=${t('캐시 적중률: 캐시 읽기 ÷ (새 입력 + 캐시 읽기 + 캐시 쓰기). 캐시 숫자를 주지 않는 AI 는 —')}>${t('캐시')}</th><th class="num">${t('답')}</th></tr></thead>
        <tbody>${b.agents.map(([id, v]) => row(agentById(id)?.name || t('삭제된 에이전트'), v, hit(v)))}</tbody></table>
      <div class="hint">${t('메시지마다 적힌 사용량으로 셌어(새로 저장하지 않아). 작성 중인 답의 추정치(~)는 세지 않아서 위의 세션 합계보다 작을 수 있어.')}${has ? ` ${t('"이 목표 것만"은 답에 단 목표 표시로 골라(실행 기록이 지워져도 남아).')}` : ''}</div>`}
  </div>`;
}

// ── 오른쪽 패널 ──
export function RightPanel({ s }) {
  const [picked, setTab] = useState('team');
  const browsing = browserUsed(s); // 브라우저를 받은 실행이 있을 때만 "브라우저" 탭(결정 0029)
  const tab = picked === 'browser' && !browsing ? 'team' : picked;
  const agents = sessionAgents(s);
  const live = state.live[s.id] || {};
  const lim = state.usage?.limits || {};
  const today = Object.fromEntries(Object.entries(state.usage?.today || {}).filter(([p]) => p !== 'mock')); // 가상 AI(mock)는 화면에 보이지 않는다(결정 0021)
  const u = sessionUsage(s);
  const L = (logs[s.id] || []).slice(-60).reverse();
  const run = latestRun(s);
  const going = run && !run.endedAt;
  // 한도가 풀리길 기다리는 에이전트(상태 paused)는 아직 실행 전이라 상세 창의 건너뛰기가 안 보여서 카드에 둔다
  const skipWait = (e, id) => { e.stopPropagation(); post(`/api/sessions/${s.id}/control`, { action: 'skip', agentId: id }).then((r) => { if (r && r.ok === false && r.reason) toast(r.reason, 'error'); }).catch((er) => toast(er.message, 'error')); };
  return html`<aside class="right">
    <div class="right-tabs seg" style="margin:10px 10px 4px">
      <button class=${tab === 'team' ? 'on' : ''} onClick=${() => setTab('team')}>${t('팀 현황')}</button>
      <button class=${tab === 'usage' ? 'on' : ''} onClick=${() => setTab('usage')}>${t('사용량·한도')}</button>
      <button class=${tab === 'log' ? 'on' : ''} onClick=${() => setTab('log')}>${t('활동 로그')}</button>
      <button class=${tab === 'mission' ? 'on' : ''} onClick=${() => setTab('mission')}>${t('진행 기록')}</button>
      ${browsing && html`<${BrowserTabButton} s=${s} on=${tab === 'browser'} onClick=${() => setTab('browser')} />`}
    </div>
    <div class="right-body">
      ${tab === 'team' && html`
        ${agents.map((a) => {
          const l = live[a.id];
          const au = agentUsage(s, a.id);
          return html`<div class=${`acard${state.ui.inspector === a.id ? ' on' : ''}`} data-agent=${a.id} onClick=${() => { state.ui.inspector = a.id; changed(); }}>
            <${Avatar} agent=${a} size=${38} />
            <div style="min-width:0">
              <div class="nm">${a.name}<${DraftChip} agent=${a} /><span class=${`sbadge ${l?.state || 'idle'}`}>${STATE_LABEL[l?.state || 'idle']}</span></div>
              <div class="sub">${a.role} · ${agentModelText(a, s)}</div>
              <div class="detail">${l?.detail || ' '}</div>
              ${going && l?.state === 'paused' && html`<button type="button" class="btn sm" style="margin:4px 0" title=${t('이 에이전트만 멈추고 다음으로')} onClick=${(e) => skipWait(e, a.id)}><${Icon} name="skip" /> ${t('건너뛰기')}</button>`}
              ${usageTotal(au) > 0 && html`<div class="sub" title=${[usageTip(au), ...treeTip(au)].join('\n')}>${t('환산 {n} 토큰', { n: fmtTok(weighted(au)) })}${partialMark(au)} ${fmtCost(au.cost)}</div>`}
            </div>
          </div>`;
        })}
        ${!agents.length && html`<div class="muted small">${t('이 세션에 배치된 에이전트가 없어.')}</div>`}`}
      ${tab === 'usage' && html`
        <div class="card"><h4>📊 ${t('이 세션')}</h4>
          <div class="stat"><span>${t('새 입력')}</span><span>${fmtTok(u.input)}</span></div>
          <div class="stat"><span>${t('캐시 쓰기')}</span><span>${fmtTok(u.cacheWrite)}</span></div>
          <div class="stat"><span>${t('캐시 읽기')}</span><span>${fmtTok(u.cacheRead)}</span></div>
          <div class="stat"><span>${t('출력')}</span><span>${fmtTok(u.output)}</span></div>
          <div class="stat" title=${t('새 입력 + 캐시 쓰기 + 출력 + 캐시 읽기÷10. 회의 사용량 상한과 같은 셈이고, 요금표와 똑같지는 않아.')}><span><b>${t('환산')}</b></span><span>${fmtTok(weighted(u))}</span></div>
          <div class="stat muted"><span>${t('네 값을 1:1 로 더한 합')}</span><span>${fmtTok(rawSum(u))}</span></div>
          <div class="stat"><span>${t('비용(추정, API 환산)')}</span><span>${fmtCost(u.cost) || '$0'}</span></div>
        </div>
        <${UseBreakdown} s=${s} />
        <div class="card"><h4>🔋 ${t('계정 한도')} <span class="small muted">${t('(실행할 때마다 갱신)')}</span></h4>
          <${Limits} lim=${lim} />
        </div>
        <div class="card"><h4>📅 ${t('오늘 (모든 세션)')}</h4>
          ${Object.entries(today).map(([p, v]) => html`<div class="stat" title=${usageTip(v)}><span><${ProviderChip} id=${p} /></span><span>${t('환산 {n} 토큰', { n: fmtTok(weighted(v)) })} ${fmtCost(v.cost)} · ${t('{n}회', { n: v.calls })}</span></div>`)}
          ${!Object.keys(today).length && html`<div class="muted small">${t('오늘 기록 없음')}</div>`}
        </div>`}
      ${tab === 'log' && html`<div class="log">
        ${L.map((x) => html`<div class="li"><span class="tm">${new Date(x.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).slice(-8)}</span><span><b>${agentById(x.agentId)?.name || x.agentId}</b> ${x.text}</span></div>`)}
        ${!L.length && html`<div class="muted small">${t('이 세션에서 아직 활동이 없어. (새로고침하면 초기화)')}</div>`}
      </div>`}
      ${tab === 'mission' && html`<${MissionLog} s=${s} />`}
      ${tab === 'browser' && html`<${BrowserTab} s=${s} />`}
    </div>
  </aside>`;
}

export const WIN_LABEL = tmap(() => ({ five_hour: t('5시간'), seven_day: t('주간'), primary: t('기본 창'), secondary: t('보조 창') })); // 목표 카드의 구독 한도 줄도 쓴다(결정 0019)
// 기록이 몇 분·시간·일 전 것인지(한도 기록 나이. 판단은 recordAge)
export function agoWords(min) {
  const a = recordAge(min);
  if (!a) return '';
  if (a.unit === 'min') return a.n < 1 ? t('방금') : t('{n}분 전', { n: a.n });
  return a.unit === 'hour' ? t('{n}시간 전', { n: a.n }) : t('{n}일 전', { n: a.n });
}
// 지난 창(초기화 시각이 지났거나, 시각을 모르는 창이 받은 지 30분이 넘음)은 지금 값이 아니다: 막대를 비우고 "—", 밑줄에 마지막으로 본 값과 나이
export function Limits({ lim }) {
  const entries = Object.entries(lim || {});
  if (!entries.length) return html`<div class="muted small">${t('아직 관측된 한도가 없어. Claude·Codex로 한 번 실행하면 표시돼.')}</div>`;
  const now = Date.now();
  return entries.map(([p, v]) => {
    const age = v.observedAt ? agoWords(Math.max(0, Math.floor((now - v.observedAt) / 60000))) : '';
    return html`<div style="margin-bottom:6px">
    <div class="row" style="gap:6px"><${ProviderChip} id=${p} />${v.plan && html`<span class="chip">${v.plan}</span>`}<span class="small muted">${t('관측 {time}', { time: new Date(v.observedAt).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}${age && ` · ${age}`}</span></div>
    ${Object.entries(v.windows || {}).map(([k, w]) => {
      const passed = windowPassed(w, v.observedAt, now);
      const pct = w.pct ?? 0;
      return html`<div class=${`limit${passed ? ' passed' : ''}`}><div class="lh"><span>${WIN_LABEL[k] || k}</span><b>${passed ? '—' : w.pct == null ? '?' : `${pct}%`}</b></div>
        <div class=${`bar${passed ? '' : pct >= 90 ? ' high' : pct >= 60 ? ' mid' : ''}`}><i style=${`width:${passed ? 0 : Math.min(100, pct)}%`}></i></div>
        <div class="ls">${passed ? t('초기화됨 · 마지막으로 본 값 {pct}% ({age})', { pct: w.pct, age }) : until(w.resetsAt)}</div></div>`;
    })}
  </div>`;
  });
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
    try {
      const r = await patch(`/api/sessions/${s.id}`, x.team ? { teamId: x.id, agentId: null } : { teamId: null, agentId: x.id });
      // 쓸 수 없는 팀으로 바꿔서 목표 모드가 저절로 꺼졌으면 이유를 알려 준다(결정 0014)
      if (r?.goalModeOff) toast(t('목표 모드를 껐어: {why}', { why: r.goalModeOff }), 'warn', 5000);
      await loadSession(s.id, true);
    } catch (e) { toast(e.message, 'error'); }
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
      <button class=${vm === 'split' ? 'on' : ''} onClick=${() => setView('split')} title=${t('흐름 무대 + 채팅')}><${Icon} name="split" size=${14} /></button>
      <button class=${vm === 'office' ? 'on' : ''} onClick=${() => setView('office')} title=${t('사무실 크게')}><${Icon} name="building" size=${14} /></button>
    </div>
    <button class="icon-btn" title=${t('대화를 마크다운(.md)으로 내보내기')} onClick=${() => exportMarkdown(s)}><${Icon} name="download" /></button>
    ${s.messages.some((m) => m.role === 'agent' && m.text && !m.handoff) && html`<button class="icon-btn" title=${t('인수인계 메모 만들기: 이 세션을 맡던 AI가 지금까지 한 일을 정리해. 다른 AI가 이어받을 때 그 메모를 먼저 받아.')} aria-label=${t('인수인계 메모 만들기')} onClick=${() => askHandoff(s.id)}><${Icon} name="hand" /></button>`}
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
  // 게시판의 결론 카드: 채팅에서 그 메시지로. "사무실 크게"(채팅 없음)면 사무실+채팅으로 바꿔서 간다
  const jumpTo = (id) => { state.ui.jumpTo = id; if ((state.settings.viewMode || 'split') === 'office') setView('split'); else changed(); };
  return html`<div class="session">
    <${TopBar} s=${s} />
    ${vm !== 'chat' && html`<${OfficePanel} s=${s} full=${vm === 'office'} onCollapse=${() => setView('chat')} onJump=${jumpTo} />`}
    ${vm === 'chat' && html`<${StageStrip} s=${s} onExpand=${() => setView('split')} />`}
    ${vm !== 'office' && html`<${Chat} s=${s} run=${run} />`}
    ${vm === 'office' && html`<${Gate} s=${s} run=${run} />`}
    <${RunBar} s=${s} run=${run} stages=${vm === 'office'} />
    <${Composer} s=${s} run=${run} />
    ${state.ui.inspector && html`<${Inspector} s=${s} agentId=${state.ui.inspector} />`}
  </div>`;
}
