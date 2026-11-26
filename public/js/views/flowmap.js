// 오른쪽 패널의 "흐름도" 탭(결정 0030): 목표 하나를 읽기 전용 그림으로. 마디·선·자리는 public/js/flow-graph.js(순수 함수)가 정하고 여기서는 SVG 로 그리기만 한다(그리기 라이브러리 없음).
// 마디를 누르거나(Enter·Space) 고르면 채팅에서 그 메시지로 간다(진행 기록 탭과 같은 jump). 화살표 키로 옆·위아래 마디, Home·End 로 처음·끝.
// 색은 앱 테마 변수만 쓰고(어두운 테마를 따라간다), 상태는 기호·낱말·테두리 모양으로도 보인다. 그릴 너비는 패널의 실제 너비라 좁은 창에서도 가로로 넘치지 않는다
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../ui.js';
import { agentById } from '../state.js';
import { t } from '../i18n/index.js';
import { flowModel, flowLayout, flowNext, stateInfo, FLOW_STATES } from '../flow-graph.js';
import { jump } from './mission.js';

const EDGE_TIP = () => ({ flow: t('흐름'), needs: t('기다리는 카드'), return: t('검수에서 되돌림'), raise: t('윗등급에게 넘김'), ask: t('사용자에게 물음'), quota: t('한도 대기') });

// 상태 모양: 테두리(점선·굵은 선·깎은 모서리·빈 칸 점선·왼쪽 띠·흐린 점선·각진 네모)
function Shape({ n }) {
  const { shape } = stateInfo(n.state);
  if (shape === 'notch') {
    const c = 8;
    return html`<polygon class="fm-box" points=${`${c},0 ${n.w - c},0 ${n.w},${c} ${n.w},${n.h - c} ${n.w - c},${n.h} ${c},${n.h} 0,${n.h - c} 0,${c}`} />`;
  }
  const rx = { round: 10, dash: 10, dotted: 10, faint: 10, bold: 6, bar: 4, square: 1 }[shape] ?? 8;
  return html`<rect class="fm-box" width=${n.w} height=${n.h} rx=${rx} />${shape === 'bar' ? html`<rect class="fm-bar" width="5" height=${n.h} rx="2" />` : ''}`;
}

export function FlowMap({ s }) {
  const box = useRef(null);
  const [width, setWidth] = useState(0);
  const [cur, setCur] = useState(null);
  const has = !!s.mission;
  // 목표가 나중에 생겨도(빈 안내 → 그림) 그때의 상자에 크기 관찰을 다시 붙인다
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const fit = () => setWidth(el.clientWidth);
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    window.addEventListener('resize', fit);
    return () => { ro?.disconnect(); window.removeEventListener('resize', fit); };
  }, [has]);
  const m = s.mission;
  if (!m) return html`<div class="muted small" ref=${box}>${t('아직 목표가 없어. 입력창 옆의 "목표까지"를 켜고 요청을 보내면 여기에 과정이 그림으로 보여.')}</div>`;
  const model = flowModel({ mission: m, runs: s.runs || [], messages: s.messages || [], nameOf: (id) => agentById(id)?.name || t('삭제된 에이전트') });
  const L = flowLayout(model, { width: Math.max(160, width || 300) });
  const focusId = L.order.includes(cur) ? cur : L.order[0];
  const go = (n) => { if (n?.msgId) jump(n.msgId); };
  // 마디는 이미 다 그려져 있으니 바로 초점을 옮긴다(다시 그린 뒤로 미루면 빨리 누른 다음 키가 옛 마디에 간다). tabindex 는 상태로 따라온다
  const move = (id) => {
    box.current?.querySelector(`[data-node="${CSS.escape(id)}"]`)?.focus();
    setCur(id);
  };
  const onKey = (e, n) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(n); return; }
    const next = flowNext(L, n.id, e.key);
    if (next) { e.preventDefault(); if (next !== n.id) move(next); }
  };
  const tip = EDGE_TIP();
  const name = (n) => { const i = stateInfo(n.state); return [n.label, i.word, n.who, n.sub].filter(Boolean).join(' · ') + (n.msgId ? '' : ` · ${t('갈 메시지 없음')}`); };
  const raiseOf = new Map(L.edges.filter((e) => e.kind === 'raise').map((e) => [e.from, e.label]));
  return html`<div class="fm-wrap" ref=${box}>
    <div class="small muted fm-head">${t('읽기 전용이야. 마디를 누르면 채팅에서 그 메시지로 가. 화살표 키로 마디를 옮겨.')}</div>
    <svg class="fm-svg" viewBox=${`0 0 ${L.width} ${L.height}`} width=${L.width} height=${L.height} role="group" aria-label=${t('목표 흐름도')}>
      <defs>
        ${['flow', 'needs', 'return', 'ask', 'quota'].map((k) => html`<marker id=${`fm-a-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class=${`fm-head-${k}`} d="M0 0 L8 4 L0 8 z" /></marker>`)}
      </defs>
      ${L.edges.map((e) => html`<path class=${`fm-edge e-${e.kind}`} d=${e.d} marker-end=${e.kind === 'raise' ? null : `url(#fm-a-${e.kind})`}><title>${e.label || tip[e.kind] || ''}</title></path>`)}
      ${L.edges.filter((e) => e.lx != null).map((e) => html`<text class="fm-elabel" x=${e.lx} y=${e.ly}>${e.label}</text>`)}
      ${L.nodes.map((n) => {
        const i = stateInfo(n.state);
        return html`<g class=${`fm-node s-${n.state} k-${n.kind}${n.msgId ? ' go' : ''}`} transform=${`translate(${n.x},${n.y})`} data-node=${n.id}
          tabindex=${n.id === focusId ? 0 : -1} role="button" aria-label=${name(n) + (raiseOf.has(n.id) ? ` · ${raiseOf.get(n.id)}` : '')} aria-disabled=${n.msgId ? null : 'true'}
          onClick=${() => { setCur(n.id); go(n); }} onKeyDown=${(e) => onKey(e, n)} onFocus=${() => setCur(n.id)}>
          <title>${name(n)}${raiseOf.has(n.id) ? `\n${raiseOf.get(n.id)}` : ''}</title>
          <${Shape} n=${n} />
          <text class="fm-ico" x="10" y="19" aria-hidden="true">${i.icon}</text>
          <text class="fm-t" x="26" y="19">${n.text}</text>
          <text class="fm-s" x="10" y="36">${n.line2}</text>
        </g>`;
      })}
    </svg>
    <ul class="fm-legend small" aria-label=${t('흐름도 범례')}>
      ${FLOW_STATES.map((st) => { const i = stateInfo(st); return html`<li class=${`s-${st}`}><svg width="22" height="14" aria-hidden="true"><${Shape} n=${{ w: 22, h: 14, state: st }} /></svg> ${i.icon} ${i.word}</li>`; })}
      <li><svg width="22" height="10" aria-hidden="true"><path class="fm-edge e-return" d="M1 5 L21 5" /></svg> ${tip.return}</li>
      <li><svg width="22" height="10" aria-hidden="true"><path class="fm-edge e-needs" d="M1 5 L21 5" /></svg> ${tip.needs}</li>
      <li><svg width="22" height="10" aria-hidden="true"><path class="fm-edge e-ask" d="M1 5 L21 5" /></svg> ${tip.ask}</li>
      <li>↑ ${tip.raise}</li>
    </ul>
  </div>`;
}
