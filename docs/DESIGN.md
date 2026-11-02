# 오피스 크루 — 설계

## 한 줄 요약
내 PC에 설치·로그인된 AI CLI(Claude Code, Codex, Gemini CLI, Hermes)와 API 키 모델을 **한 화면**에서 묶어 쓰는 로컬 웹앱.
에이전트(모델·노력·권한·스킬·커넥터)를 만들고, 팀 배치(파이프라인)로 한 세션에서 돌리며, 사무실 애니메이션으로 실시간 관전·개입한다.

## 목표 / 비목표 / 피해야 할 것
- 목표: 구독 로그인 재사용, 에이전트별 라우팅, 팀 파이프라인, 실시간 관전+개입, 데스크톱 앱 같은 채팅 UX, 가벼움.
- 비목표: 자체 LLM 서버, 클라우드 동기화, 다중 사용자 계정.
- 피해야 할 것: 무거운 의존성(Electron·DB 서버·빌드 도구), 단계 가시성 부족, 에이전트 출력의 HTML 실행(XSS), 외부 사이트에서 로컬 서버 호출(CSRF/DNS 리바인딩).

## 기술 선택
- 서버: Node.js ≥ 20, **런타임 의존성 0개**(Node.js 기본 모듈만). 실시간은 SSE.
- 프론트: 빌드 없음. Preact 10 + htm(벤더 포함, ~16KB) + 순수 CSS. import map 사용.
- 저장: `OFFICE_CREW_HOME`(기본 `~/.office-crew`) 아래 JSON 파일. 세션은 파일 1개씩.
- 실행: `npm start` → 서버(127.0.0.1:4317) + Edge/Chrome `--app` 창(프로그램처럼). PWA 설치도 가능.
- 보안: 127.0.0.1 바인딩, Host·Origin 헤더 검사(DNS 리바인딩·교차 사이트 요청 차단), 첫 실행 때 만들어 `.token`에 저장한 설치별 토큰을 `X-Office-Token` 헤더/`?token=`로 요구, 출력은 항상 이스케이프 후 마크다운 렌더.

## 폴더 구조
```
bin/office-crew.js            실행기(서버 + 앱 창)
server/index.js             HTTP 라우팅, 정적 파일, 보안
server/store.js             JSON 저장소(원자적 쓰기, 디바운스)
server/bus.js               SSE 이벤트 허브
server/orchestrator.js      실행(run) 엔진: 단계 진행, 병렬, 승인 게이트, 개입
server/usage.js             토큰·비용 집계, 계정 한도
server/catalog.js           스킬·커넥터·플러그인 목록
server/routing.js           자동 라우팅(역할×프로필 → 프로바이더·모델·노력)
server/failover.js          자동 이어받기(한도 오류 판별, 쉬는 시간, 대체 AI 고르기, 이어받기 지시)
server/importer.js          Claude Code·Codex 기록(jsonl) 목록·읽기(원본은 읽기만)
server/storage.js           저장공간 보고·정리
server/providers/index.js   프로바이더 레지스트리(각 어댑터의 detect: 설치·로그인 탐지, models: 모델 목록)
server/providers/*.js       어댑터: claude, codex, gemini, hermes, openai(호환 API), local(내 PC 모델), acp(ACP 표준 에이전트), mock
server/providers/util.js    셸 없이 CLI 실행(.cmd 래퍼 해석), 줄 단위 읽기, 프로세스 트리 종료
server/providers/feeder.js  stdin 스트림 JSON 다중 턴(작업 중 지시 주입)
public/index.html           앱 셸(import map)
public/js/*.js              UI(Preact+htm)
public/js/office/*.js       사무실 렌더러(독립 모듈)
public/css/*.css
test/*.test.js              node:test
```

## 데이터 모델
```
Agent    { id, name, role, emoji, provider, model, effort, systemPrompt,
           permission: 'plan'|'default'|'edit'|'auto'|'full',
           skills:[skillId], connectors:[connectorId], light:boolean,
           apiProfile?: string, avatar:{ skin, hair, hairStyle, outfit, accessory } , createdAt }
Team     { id, name, description, stages:[ { id, label, agentIds:[...], instruction, approve:boolean } ] }
Session  { id, title, teamId|null, agentId|null, cwd, createdAt, updatedAt,
           providerSessions:{ [agentId]: string }, sessionProvider:{ [agentId]: providerId },
           importedFrom?:{ source:'claude'|'codex', id, cwd, total, at }, messages:[Message], runs:[Run] }
Message  { id, role:'user'|'agent'|'system', agentId?, runId?, stageIndex?, text,
           attachments:[{id,name,mime,size,path}], blocks:[Block], status:'streaming'|'done'|'error'|'stopped',
           usage?:{input,output,cacheRead,cacheWrite,cost,durationMs}, createdAt }
Block    { id, kind:'tool'|'thinking'|'notice', name?, input?, output?, status:'running'|'done'|'error' }
Run      { id, teamId|null, status:'running'|'paused'|'waiting'|'done'|'error'|'stopped',
           stageIndex, stages:[{ label, agentIds, status }], startedAt, endedAt }
```

## 프로바이더 어댑터 계약
```js
export default {
  id, label, kind: 'cli'|'api'|'mock', color,
  efforts: [...],                    // 지원 노력 단계
  caps: { images, steer, resume, tools, connectors, permissions },
  async detect(settings) -> { installed, version, loggedIn, account, note },
  async models(settings) -> [{ id, label }],
  run(opts, emit) -> { stop(), steer(text)?, done: Promise<{ text, providerSessionId, error, stopped }> }   // 사용량은 emit({type:'usage'})로
}
opts = { agent, prompt, system, images:[path], cwd, resumeId, settings, connectors, tmpDir, addDirs, mcpConfigPath, history, forkSession }
emit(ev):
  { type:'text', text }              // 출력 조각(누적 아님)
  { type:'thinking', text }
  { type:'tool', id, name, input, status:'running'|'done'|'error', output? }
  { type:'usage', input, output, cacheRead, cacheWrite, cost }
  { type:'limits', provider, windows:{ five_hour?:{pct,resetsAt}, seven_day?:{pct,resetsAt}, primary?:... } }
  { type:'session', id }
  { type:'notice', text }
```

## 실행 엔진(오케스트레이터)
- 사용자 메시지 → Run 생성. 팀이 있으면 단계 순서대로, 한 단계 안의 에이전트는 병렬.
- 각 에이전트 프롬프트 = 역할 지시 + 팀 맥락 + (첫 단계면) 사용자 요청 / (다음 단계면) 사용자 요청 + 이전 단계 결과 + 개입 지시.
- 에이전트마다 CLI 세션 ID를 세션에 저장 → 다음 턴은 resume으로 이어감(기억 유지).
- `@이름` 멘션 → 그 에이전트에게만 보냄. 팀 없는 세션 → 단일 에이전트 채팅.
- 개입: steer(지시 추가: Claude는 실행 중 stdin 주입, 나머지는 턴 종료 후 이어서 실행), pause(현재 단계 끝나면 멈춤), resume, stop(프로세스 트리 종료), skip(현재 에이전트 중단 후 다음), retry(단계 재실행), approve/reject(승인 게이트, 거절 시 피드백 붙여 재실행).

### 이어갈 대화(resume)
- `providerSessions[agentId]`에 CLI 대화 id, `sessionProvider[agentId]`에 그 대화를 만든 프로바이더를 같이 저장한다. 지금 실행할 프로바이더가 다르면(자동 라우팅·이어받기로 바뀜) 이어하기를 하지 않는다.
- 이어갈 대화가 없거나 이어하기가 실패하면, 이 세션의 최근 대화(이번 실행의 앞 단계 결과는 제외)를 `[이전 대화]`로 프롬프트 앞에 넣어 맥락을 잇는다.

### 세션 불러오기(`server/importer.js`)
- `GET /api/import/list?q=` → Claude Code(`~/.claude/projects/*/<id>.jsonl`)·Codex(`~/.codex/sessions/**/rollout-*.jsonl`) 기록 목록(앞·뒤 64KB만 읽어 제목·미리보기, 못 찾으면 512KB까지 더 읽음, mtime 캐시).
- `POST /api/import {source, id}` → 대화를 앱 메시지로 옮긴 새 세션(원래 폴더가 있으면 그 폴더), 전용 에이전트 `import-claude`·`import-codex`, `providerSessions`에 원래 대화 id.
- Claude는 첫 이어하기 때 `--resume <id> --fork-session`으로 갈래를 만들어 원래 기록 파일을 그대로 둔다. Codex `exec resume`엔 갈래 옵션이 없어 같은 스레드에 이어 붙는다.

### 자동 이어받기(`server/failover.js`)
- 실행 중 오류가 한도 문구(`isQuotaError`)면: 그 프로바이더를 쉬게 표시(`Cooldown`, 초기화 시각을 모르면 30분) → 같은 역할·프로필로 라우팅 엔진에 다시 물어 다른 AI를 고름(`pickFallback`, 이미 시도한 AI 제외) → `continuationPrompt`(원래 요청 + 지금까지 쓴 글)로 같은 메시지에 이어서 실행. 여러 번 연쇄 가능.
- 실행 전: 직접 설정 에이전트의 AI가 쉬는 중이거나 한도 사용률이 기준(`failoverThreshold`, 기본 95%) 이상이면 이번 실행만 대체 AI로. 자동 라우팅은 막힌 AI를 빼고 고른다(전부 막히면 원래 목록으로 시도).
- 설정: `failover`(기본 켬), `failoverThreshold`. API: `GET /api/cooldown`, `DELETE /api/cooldown/:provider`. 이벤트: `cooldown`.
- 쉬게 표시하는 건 계정 단위 한도가 있는 CLI(claude·codex·gemini·hermes)뿐이다. API 프로필·ACP 에이전트는 서로 다른 계정일 수 있어 통째로 막지 않는다. 내 PC 모델(local) 작업은 데이터가 밖으로 나가지 않게 다른 AI로 넘기지 않는다.
- 크기 한도(문맥 길이·max_tokens·파일 크기)는 사용량 한도로 보지 않는다. 이어하기 중 나온 한도 오류는 "이어하기 실패"로 처리하지 않는다(원래 대화 id 유지).
- 남은 AI가 모두 한도 임박이면 그중에서라도 마지막으로 시도한다(쉬는 중·거절 상태는 계속 제외). 이어받는 AI 기준으로 프롬프트를 다시 만들고, 이어하기가 되는 AI면 앞 대화도 넣는다.
- 화면의 쉬는 목록(`restingList`)은 쉬는 중 + 한도 임박(near)을 합친 것. "지금 다시 쓰기"는 쉬는 표시와 저장된 한도 기록(거절 상태 포함, `releasedAt`)을 함께 푼다. 거절 기록은 초기화 시각이 지나면 저절로 풀린다.

### 결제 방식(`authEnv`, util.js)
- `settings.authMode.{claude,codex}` = `login`(구독, 기본) | `apikey`.
- `apikey`: 앱에 키를 넣었으면 `ANTHROPIC_API_KEY`/`CODEX_API_KEY`로 넣는다(Claude 는 키보다 우선하는 `ANTHROPIC_AUTH_TOKEN`을 뺀다). 앱 키가 없으면 PC 환경변수(키·게이트웨이 토큰)를 손대지 않고 그대로 쓴다.
- `login`: `ANTHROPIC_API_KEY`·`ANTHROPIC_AUTH_TOKEN`(Claude), `CODEX_API_KEY`(Codex)를 자식 프로세스 환경에서 뺀다(윈도우는 대소문자 무시). `-p`/`exec` 모드에선 환경변수 키가 구독보다 우선이라, 빼지 않으면 구독을 골라도 API로 과금될 수 있다.
- 앱은 CLI 로그인 토큰 파일(`~/.claude/.credentials.json`, `~/.codex/auth.json`)을 읽지 않는다. 로그인 상태는 `claude auth status`·`codex login status` 출력으로만 판단한다.

### ACP 에이전트(`server/providers/acp.js`)
- 줄 단위 JSON-RPC 2.0(stdio). `initialize`(protocolVersion 1, fs 읽기, 편집 권한일 때만 fs 쓰기, terminal 없음) → `session/new`(cwd, mcpServers, 지원하면 `systemPrompt` append) → `session/prompt`.
- `session/update`: agent_message_chunk→text, agent_thought_chunk→thinking, tool_call/tool_call_update→tool, plan→조용한 알림.
- 에이전트의 요청: `session/request_permission`은 권한 단계(plan·default=읽기류만, edit=읽기+편집, auto·full=전부)로 즉시 응답, `fs/read_text_file`은 작업 폴더·첨부 폴더 안만, `fs/write_text_file`은 편집 권한 + 작업 폴더 안만, 나머지는 -32601.
- 중지: `session/cancel` 알림 후 2.5초 안에 안 끝나면 프로세스 종료. 에이전트 목록은 `settings.acpAgents`, 에이전트의 `model` = ACP 에이전트 id.

## SSE 이벤트(`/api/events?token=`)
```
hello {version}
session {session meta}             sessions:list 갱신
message {sessionId, message}       새 메시지
delta {sessionId, messageId, text} 텍스트 조각 추가
block {sessionId, messageId, block} 도구/생각 블록 추가·갱신
messageDone {sessionId, messageId, status, usage}
agentState {sessionId, agentId, state, detail, tool}
run {sessionId, run}
handoff {sessionId, from, to, label}
usage {byProvider, byAgent, today, limits}
providers {list}
cooldown {provider: {until, reason}}
messageMeta {sessionId, messageId, model, provider?, effort?}
```
agentState.state ∈ idle | thinking | typing | tool | searching | reading | running | waiting | error | done | paused | offline

## REST API(모두 토큰 필요)
```
GET  /api/bootstrap                  agents, teams, sessions(메타), settings, providers, usage, skills, connectors, plugins
GET  /api/providers?refresh=1        탐지 결과
POST /api/providers/:id/login        로그인용 터미널 창 열기
GET  /api/providers/:id/models
POST·PUT·DELETE /api/agents, /api/teams, /api/connectors, /api/skills (목록은 bootstrap), DELETE /api/plugins/:id
GET  /api/sessions/:id               전체 세션
POST /api/sessions                   {title?, teamId?, agentId?, cwd?}
PATCH/DELETE /api/sessions/:id
POST /api/sessions/:id/messages      {text, attachments:[id], mention?}
POST /api/sessions/:id/control      {action, runId?, agentId?, text?}
POST /api/uploads                    (바이너리 본문, X-File-Name) → {id,name,mime,size}
GET  /api/uploads/:id
GET/PUT /api/settings               (apiKeys·authMode·failover·acpAgents 검증, 일부만 보내도 나머지 유지)
GET  /api/import/list?q=, POST /api/import {source, id}
GET  /api/cooldown, DELETE /api/cooldown/:provider
GET  /api/acp/presets
GET  /api/routing/catalog, POST /api/routing/preview, POST /api/routing/apply
GET  /api/storage, POST /api/storage/cleanup
POST /api/plugins/import, POST /api/plugins/export
POST /api/sessions/:id/open-folder
```

## 사무실 렌더러 계약(public/js/office/index.js)
```js
createOffice(container, { skin, reducedMotion, onSelect(agentId) }) -> office
office.setAgents([{ id, name, role, model, color, avatar }])   // 책상 자동 배치(최대 12)
office.setState(id, { state, text, tool, tokens, badge })      // 상태별 애니메이션
office.handoff(fromId, toId, label) -> Promise                 // 서류 들고 걸어가 전달
office.setSkin(skinIdOrObject); office.select(id|null); office.destroy()
SKINS (내장 3종 + custom: 배경 이미지 + 책상 좌표)
createSkinEditor(container, { skin, onSave(skinObj), onCancel })
```
SVG 아이소메트릭(2.5D) 일러스트, CSS transform 애니메이션, 탭 숨김 시 정지, 줄이기 모드 지원.
