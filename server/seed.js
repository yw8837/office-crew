import { tr } from './i18n.js';

// 첫 실행 기본 데이터(첫 실행 때의 화면 언어로 만든다): 기본 팀(조사-소네트 → 정리-솔 → 분석-오푸스 하이 → 빌드-오푸스 X하이), 자동 라우팅 팀, 사용량 0인 데모 팀

export function defaultSettings() {
  return {
    theme: 'system',            // system | light | dark
    skin: 'village',            // 오피스 스킨 id(기본: 크루 마을)
    reducedMotion: false,
    viewMode: 'split',          // chat | office | split
    defaultTeamId: 'team-demo',
    defaultAgentId: 'demo-researcher',
    defaultCwd: '',             // 비우면 세션마다 ~/.office-crew/workspaces/<세션id>
    historyTurns: 8,            // 기억(resume) 못 하는 모델에 넣어줄 최근 대화 수
    memory: false,              // 프로젝트 기억: 끝난 대화를 작업 폴더별로 쌓고, 실행을 시작할 때 관련 조각을 넣는다
    memoryBudget: 2000,         // 실행마다 넣는 기억의 최대 글자 수
    sendOnEnter: true,
    apiKeys: { gemini: '', anthropic: '', openai: '' }, // anthropic=Claude Code용, openai=Codex용(API 키 모드일 때만 씀)
    authMode: { claude: 'login', codex: 'login' },     // login=구독 로그인 | apikey=API 키(사용한 만큼 과금)
    localServers: [],           // 직접 추가한 로컬 모델 서버 [{name, baseUrl}] (기본 포트는 자동 감지)
    lang: '',                   // 화면 언어 ko|en|zh|ja (비우면 브라우저 언어)
    officeQuality: 'full',      // 사무실 그래픽 full|lite|static(저사양)
    acpAgents: [],              // ACP 표준 에이전트 [{id, name, command, args[], env{}}] (설정에서 프리셋 추가)
    failover: true,             // 사용량 한도에 걸리면 여유 있는 다른 AI가 이어받기
    failoverThreshold: 95,      // 한도 사용률이 이 % 이상이면 실행 전에 미리 피함
    stallMinutes: 30,           // 출력이 이만큼 없으면 멈춘 걸로 보고 끈다(도구가 도는 중엔 4배, 0이면 끔)
    dailyBudget: false,         // 하루 예산: 켜면 주간 한도의 일정 몫만 하루에 쓰게 조절
    dailyBudgetPercent: 13,     // 하루 몫(주간 사용률 %포인트, 1/7 ≈ 14)
    phoneNotify: false,         // 휴대폰 알림: 사용자가 정한 주소로 상태만 보낸다
    phoneType: 'ntfy',          // ntfy | webhook
    phoneUrl: '',
    desktopNotify: false,       // 창이 뒤에 있을 때 승인 대기·작업 끝을 데스크톱 알림으로
    apiProfiles: [
      { id: 'openai', name: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-5.1' },
      { id: 'openrouter', name: tr('OpenRouter (Hermes·Grok·DeepSeek 등)'), baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'nousresearch/hermes-4-405b' },
      { id: 'nous', name: 'Nous Portal (Hermes)', baseUrl: 'https://inference-api.nousresearch.com/v1', apiKey: '', model: 'Hermes-4-405B' },
      { id: 'xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', apiKey: '', model: 'grok-4' },
      { id: 'gemini-api', name: 'Google Gemini API', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', model: 'gemini-2.5-pro' },
    ],
  };
}

const av = (skin, hair, hairStyle, outfit, accessory = 'none') => ({ skin, hair, hairStyle, outfit, accessory });

export function seedData() {
  const agents = [
    {
      id: 'researcher', name: tr('리서처'), role: tr('조사'), emoji: '🔎', provider: 'claude',
      model: 'sonnet', effort: 'medium', permission: 'plan', light: false,
      systemPrompt: tr('너는 조사 담당이야. 필요한 자료를 찾아 핵심 사실과 출처를 정리해. 확인 안 된 건 "추정"이라고 표시해.'),
      skills: [], connectors: [], avatar: av('#f2c9a6', '#2b2a33', 'bob', '#3b82f6', 'glasses'),
    },
    {
      id: 'organizer', name: tr('정리왕'), role: tr('정리'), emoji: '🗂️', provider: 'codex',
      model: 'gpt-6.1-sol', effort: 'medium', permission: 'plan', light: false,
      systemPrompt: tr('너는 정리 담당이야. 앞 단계 결과를 중복 없이 구조화해서 표·목록으로 정리해.'),
      skills: [], connectors: [], avatar: av('#e8b996', '#5a3825', 'short', '#10a37f'),
    },
    {
      id: 'analyst', name: tr('분석가'), role: tr('분석'), emoji: '🧠', provider: 'claude',
      model: 'opus', effort: 'high', permission: 'plan', light: false,
      systemPrompt: tr('너는 분석 담당이야. 정리된 내용을 근거로 판단·우선순위·위험을 분석하고 실행 계획을 세워.'),
      skills: [], connectors: [], avatar: av('#f5d0b5', '#1d1d24', 'long', '#d97757', 'headset'),
    },
    {
      id: 'builder', name: tr('빌더'), role: tr('빌드'), emoji: '🛠️', provider: 'claude',
      model: 'opus', effort: 'xhigh', permission: 'edit', light: false,
      systemPrompt: tr('너는 빌드 담당이야. 분석·계획을 바탕으로 작업 폴더에 실제 결과물을 만들고, 만든 파일과 확인 결과를 보고해.'),
      skills: [], connectors: [], avatar: av('#d9a77f', '#3a2a1e', 'spiky', '#8b5cf6'),
    },
    {
      id: 'demo-researcher', name: tr('데모 조사봇'), role: tr('조사'), emoji: '🔎', provider: 'mock', model: 'mock-fast', effort: 'medium',
      permission: 'plan', systemPrompt: tr('데모용 가상 에이전트(사용량 0).'), skills: [], connectors: [], avatar: av('#f2c9a6', '#6b4226', 'ponytail', '#0ea5e9'),
    },
    {
      id: 'demo-organizer', name: tr('데모 정리봇'), role: tr('정리'), emoji: '🗂️', provider: 'mock', model: 'mock-fast', effort: 'medium',
      permission: 'plan', systemPrompt: tr('데모용 가상 에이전트(사용량 0).'), skills: [], connectors: [], avatar: av('#e3b38f', '#222', 'short', '#22c55e'),
    },
    {
      id: 'demo-analyst', name: tr('데모 분석봇'), role: tr('분석'), emoji: '🧠', provider: 'mock', model: 'mock-fast', effort: 'high',
      permission: 'plan', systemPrompt: tr('데모용 가상 에이전트(사용량 0).'), skills: [], connectors: [], avatar: av('#f6d5bd', '#b04a2f', 'long', '#f97316', 'glasses'),
    },
    {
      id: 'demo-builder', name: tr('데모 빌드봇'), role: tr('빌드'), emoji: '🛠️', provider: 'mock', model: 'mock-fast', effort: 'xhigh',
      permission: 'edit', systemPrompt: tr('데모용 가상 에이전트(사용량 0).'), skills: [], connectors: [], avatar: av('#c98f68', '#111', 'spiky', '#a855f7', 'headset'),
    },
  ];
  // 자동 라우팅 에이전트: 실행할 때마다 로그인된 AI 중에서 역할에 맞는 모델·노력을 고른다(언제든 직접 설정으로 바꿀 수 있음)
  const auto = (id, name, role, emoji, permission, systemPrompt, a) => ({
    id, name: tr(name), role: tr(role), emoji, provider: 'claude', model: '', effort: '', permission, light: false, routing: 'auto', routingProfile: 'balanced',
    systemPrompt: tr(systemPrompt), skills: [], connectors: [], avatar: a,
  });
  agents.push(
    auto('auto-research', '자동 조사', '조사', '🔎', 'plan', '필요한 자료를 찾아 핵심 사실과 출처를 정리해. 확인 안 된 건 "추정"이라고 표시해.', av('#f6d5bd', '#4f46e5', 'bob', '#3b82f6', 'glasses')),
    auto('auto-organize', '자동 정리', '정리', '🗂️', 'plan', '앞 단계 결과를 중복 없이 표·목록으로 정리해.', av('#e3b38f', '#1d1d24', 'short', '#10a37f')),
    auto('auto-analysis', '자동 분석', '분석', '🧠', 'plan', '근거를 바탕으로 판단·우선순위·위험을 분석하고 실행 계획을 세워.', av('#f2c9a6', '#b04a2f', 'long', '#d97757', 'headset')),
    auto('auto-build', '자동 빌드', '빌드', '🛠️', 'edit', '계획대로 작업 폴더에 실제 결과물을 만들고, 만든 파일과 확인 결과를 보고해.', av('#c98f68', '#3a2a1e', 'spiky', '#8b5cf6')),
    auto('auto-review', '자동 검수', '검수', '🛡️', 'plan', '만든 결과를 요구사항 기준으로 검토해 문제·누락·개선점을 목록으로 지적해.', av('#d9a77f', '#9aa3ad', 'ponytail', '#ef4444', 'glasses')),
  );
  const teams = [
    {
      id: 'team-default', name: tr('기본 팀'), description: tr('조사(소네트) → 정리(솔) → 분석(오푸스 하이) → 빌드(오푸스 X하이)'),
      stages: [
        { id: 'st-1', label: tr('조사'), agentIds: ['researcher'], instruction: '', approve: false },
        { id: 'st-2', label: tr('정리'), agentIds: ['organizer'], instruction: '', approve: false },
        { id: 'st-3', label: tr('분석'), agentIds: ['analyst'], instruction: '', approve: true },
        { id: 'st-4', label: tr('빌드'), agentIds: ['builder'], instruction: '', approve: false },
      ],
    },
    {
      id: 'team-auto', name: tr('자동 라우팅 팀'), description: tr('로그인된 AI 중에서 역할별 모델·노력을 자동 배정 (조사→정리→분석→빌드→교차 검수)'),
      stages: [
        { id: 'st-a1', label: tr('조사'), agentIds: ['auto-research'], instruction: '', approve: false },
        { id: 'st-a2', label: tr('정리'), agentIds: ['auto-organize'], instruction: '', approve: false },
        { id: 'st-a3', label: tr('분석'), agentIds: ['auto-analysis'], instruction: '', approve: true },
        { id: 'st-a4', label: tr('빌드'), agentIds: ['auto-build'], instruction: '', approve: false },
        { id: 'st-a5', label: tr('검수'), agentIds: ['auto-review'], instruction: '', approve: false },
      ],
    },
    {
      id: 'team-demo', name: tr('데모 팀 (사용량 0)'), description: tr('가상 에이전트로 화면·애니메이션·개입 기능을 체험'),
      stages: [
        { id: 'st-d1', label: tr('조사'), agentIds: ['demo-researcher'], instruction: '', approve: false },
        { id: 'st-d2', label: tr('정리·분석'), agentIds: ['demo-organizer', 'demo-analyst'], instruction: '', approve: true },
        { id: 'st-d3', label: tr('빌드'), agentIds: ['demo-builder'], instruction: '', approve: false },
      ],
    },
  ];
  return { agents, teams, connectors: [], skills: [], skins: [], plugins: [] };
}
