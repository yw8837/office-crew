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
- 저장: `OFFICE_CREW_HOME`(기본 `~/.office-crew`) 아래 JSON 파일. 세션은 파일 1개씩. 역할 노트는 에이전트마다 `notes/<에이전트 id>.json` 1개씩(결정 0013).
- 실행: `npm start` → 서버(127.0.0.1:4317) + Edge/Chrome `--app` 창(프로그램처럼). PWA 설치도 가능.
- 보안: 127.0.0.1 바인딩, Host·Origin 헤더 검사(DNS 리바인딩·교차 사이트 요청 차단), 첫 실행 때 만들어 `.token`에 저장한 설치별 토큰을 `X-Office-Token` 헤더/`?token=`로 요구, 출력은 항상 이스케이프 후 마크다운 렌더.

## 폴더 구조
```
bin/office-crew.js            실행기(서버 + 앱 창)
server/index.js             HTTP 라우팅, 정적 파일, 보안
server/store.js             JSON 저장소(원자적 쓰기, 디바운스)
server/bus.js               SSE 이벤트 허브
server/orchestrator.js      실행(run) 엔진: 단계 진행, 병렬, 승인 게이트, 개입
server/ask.js               에이전트가 사용자에게 묻기: 답 끝의 oc-ask 블록 읽기, 답을 돌려주는 글(결정 0009)
server/meeting.js           회의 차례: 반대편 고르기, 차례 순서, 진행자 답 끝의 oc-verdict 판정 블록 읽기(결정 0010), 차례 답 끝의 oc-check 질문 블록 읽기와 조사 담당 고르기(결정 0011)
server/notes.js             역할 노트: 에이전트마다 하는 일·항목·변경 기록 파일, 바깥에서 온 항목의 주입 무늬 거르기, 되돌리기, 시스템 지시에 넣을 항목 고르기(결정 0013)
server/mission.js           목표 모드: oc-goal 목표 카드 블록 읽기·다듬기, 본 카드와 저장된 초안 대조, 진행자 고르기, 내 PC 모델 섞임 검사, 진행 기록, 끊김 표시(결정 0014). 끊긴 목표 이어서의 단계표 대조·끊긴 자리 읽기·앞 단계 결과 다시 모으기(결정 0016). 일하기 전 조사와 회의의 조사 담당·참석자 고르기, 회의 호출 수 식, oc-research 조사 질문 블록, 훑어보기·질문·조사 프롬프트, 조사 노트·회의 결론 블록(결정 0017). 일 카드의 oc-cards 계획 블록 읽기·다듬기, 담당 대조, 단계(물결) 나누기, 계획·카드 프롬프트, 끝의 두 칸·oc-blocked 막힘 블록(결정 0018). 호출 어림 조각(estimateParts·estimateCalls), 한도 대기의 끊긴 자리 읽기(결정 0019).
                            새 눈 검수: 검수자와 기준 판정으로 대신할 단계 고르기(reviewPlan), 검수 프롬프트, oc-review 판정 블록 읽기, 판정 적기, 되돌림 블록(결정 0015)
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
public/js/mission-numbers.js 목표 카드의 숫자: 호출 어림 더하기(sumEstimate, 서버 estimateCalls 도 이 함수를 부른다), 받은 한도 기록에서 보일 창 고르기(limitRows), 기록 나이 단위(recordAge)(결정 0019)
public/js/stage-model.js    흐름 무대의 모델(DOM 없음): 마지막 실행·실시간 상태·목표·질문·팀 → 역·사람·내 차례·문 자리·끝 깃발. 회의 차례 이름(meetLabel)·목표 대기 표시(goalWait)도 여기(결정 0020)
public/js/views/stage.js    흐름 무대(나눠 보기의 위쪽 그림, FlowStage)와 접은 한 줄 띠(StageStrip)(결정 0020)
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
Team     { id, name, description, stages:[ { id, label, agentIds:[...], instruction, approve:boolean, meeting:null|{ rounds, chairId, tokenCap, opposeId:null|agentId(반대편. null 이면 실행 때 자동으로 고른다, 결정 0010) } } ] }
Session  { id, title, titleFrom?(제목을 만든 사용자 말 id), titleLocal?(그 말이 내 PC 모델만 받은 말이면 true: 기억 출처 줄에 제목을 싣지 않는다), teamId|null, agentId|null, cwd, createdAt, updatedAt,
           providerSessions:{ [agentId]: string }, sessionProvider:{ [agentId]: providerId },
           usageBase?:{ [agentId]: { id, input, output, cacheRead, cacheWrite, cost } }(Claude 사용량의 직전 누적. id 는 다음 호출이 이어 갈 CLI 대화 id 이고, 그 대화를 그대로 이어 갈 때만 뺀다. 믿을 수 없게 되면 지운다. 결정 0012),
           noteHashes?:{ [agentId]: string }(이어 갈 수 있는 AI 의 대화가 마지막으로 끝까지 받은 역할 노트 블록의 해시. 무작위 표식은 뺀다. 없으면 노트를 받은 적 없는 걸로 본다. 이어 가는 실행에서 다르면 지시를 다시 붙인다. 결정 0013),
           importedFrom?:{ source:'claude'|'codex', id, cwd, total, at, agentId?(불러올 때 만든 에이전트), remembered?(불러온 대화를 프로젝트 기억에 다 넣었음), cleared?(대화를 비웠음: 불러온 대화를 더는 건네지 않는다), checked?(원문이 없어 원래 기록을 다시 읽어 봤음) }, messages:[Message], runs:[Run],
           goalMode?:boolean(목표 모드, 결정 0014), mission?:Mission }
Mission  (세션에 하나. 새 목표가 끝난 목표를 덮어쓴다. 결정 0014·0015·0016·0017·0018·0019)
         { version:1, id, status:'drafting'|'draft'|'active'|'waiting'(판정 뒤 묻기·호출 상한·한도 대기)|'done'(기준 전부 통과)|'accepted'(사용자가 받아들임)|'stopped'|'cancelled'|'cut'|'unreviewed'(2a-1 의 옛 끝 상태),
           phase:'goal'|'scan'|'questions'|'research'|'meeting'|'plan'|'work'|'review', request(앞 2,000자), requestMsgId, leadId, goal(200자), criteria:[{ id:'c1', text(300자), status:'open'|'pass'|'fail'|'unknown', evidence(검수자가 씀, 500자), check?(확인 방법 200자, 결정 0014 개정) }](7개까지), mustKeep:[…](바뀌면 안 되는 것 5개·200자),
           reviewerId|null(검수자. 확인할 때 정한다), dropped:[단계 이름](기준 판정으로 대신해 건너뛴 검수 단계), round(검수 횟수), returns(되돌린 횟수), returnCap(되돌림 상한, 처음 1),
           calls:{ used, cap }(CLI 호출 수와 상한. 목표 차례부터 센다. 상한 기본 40), extras:[…](마지막 검수의 남은 일, 막지 않음), keepBroken:[…](마지막 검수가 본 지킬 것 어김, 묻는다), repeatFail:[기준 id](두 회차 연속 불합격. 다음 되돌림에 가정 적기. 결정 0015 개정),
           keep:[팀 단계 번호](확인 때 "남기기"를 고른 검수 단계. 이어서 할 때 같은 단계표를 다시 만든다), cwd(확정 때의 작업 폴더), roles:{ [에이전트 id]: roleKind }(확정 때 팀원의 역할 종류. 이어서 할 때 대조. 결정 0016),
           prep:{ research, meeting, direct }(확인 때 고른 일하기 전 대목. 진행자가 바로 실행을 권했는지. 결정 0017), research:null|{ scanMsgId, questions:[{ id:'q1', text(200자), agentId, status:'pending'|'running'|'done'|'empty'|'failed'|'skipped', msgId, outside? }](6개까지), noteMsgId(조사 노트 카드), fallback?(질문 블록을 못 읽어 질문 하나로) }, meetingMsgId|null(일하기 전 회의의 결론 답),
           at:{ stageIndex, phase:'scan'|'questions'|'research'|'meeting'|'plan'|'work'|'review', back(되돌림 중), working:[에이전트 id](CLI 를 띄운 채 일하는 사람. 띄울 때 넣고 앱이 끄지 않은 채 끝나면 뺀다. 회의의 조사 담당·검수자도), finished:[메시지 id](이 단계에서 끝낸 답, 회의는 결론), wait:null|{ reason:'approve' }|{ reason:'error', failed:[{ agentId, error }] }|{ reason:'mission', kind:'verdict'|'notes' }|{ reason:'cap', quota?:true(한도 대기 뒤 다시 하기 앞, 결정 0019) }|{ reason:'quota', until(아는 초기화 시각 ms. 지났어도 그대로, 모르면 0), failed:[{ agentId, error, provider(한도에 걸린 AI) }] }(한도 대기, 결정 0019) }(끊긴 자리. 단계 시작·끝, 되돌림 결정, 다시 하기·거절, 대기 시작, 사람마다의 시작·끝에 고치고 바로 저장. 결정 0016),
           work:'cards'|'stages'(일하는 방식, 결정 0018), cards:null|[{ id:'k1', title(120자), ownerId, kind:'research'|'write'|'build'|'check', needs:[앞 카드 id], done(200자), files:[…](8개·200자), not(200자), status:'waiting'|'running'|'done'|'blocked'|'skipped'|'hole', by?:'blocked'|'quota'(구멍의 사유: 막힘 받아들이기·한도 대기 건너뛰기, 결정 0019), starts, cap(처음 3), msgId, tailMsgId?, tail?, reason? }](6장까지), rate:{ cap(처음 20), starts:[시각](한 시간 안에 시작한 카드) }, planMsgId(계획 카드),
           outOfScope:[…](5개·200자), userDecides:[…](5개·200자), notes:[{ id, text, at, used, msgId, files?:[{name,path}] }](도는 중에 온 추가 지시. 50개까지),
           estimate?:{ min, max, returns, cap, spent }(확인 시점의 호출 어림. 목표 잡기에 쓴 호출 포함. 옛 목표엔 없다), quota?:{ autos }(한도 대기에서 자동 이어서를 쓴 횟수, 3번까지. 결정 0019),
           cardMsgId, confirmedAt, editedByUser, cutNotice?('drafting'|'cut': 다시 켤 때 대화에 한 줄 남기고 지운다), log:[{ at, kind(… 'quota' 한도 대기), text, msgId?, n?, fail?:'review'|'outside'|'blocked'|'hole'|'keep' }](200줄, 넘으면 맨 앞에 "앞 n줄 생략" 한 줄 kind 'skip'·n), createdAt }
         살아 있는 목표 = drafting·draft·active·waiting·cut: 새 목표를 못 만들고, 목표 모드 끄기·팀 바꾸기는 409
Message  { id, role:'user'|'agent'|'system'|'proposal'(kind 'hire': 영입 제안 카드, 결정 0006 / kind 'goal': 목표 카드 { missionId, leadId, draftMsgId(카드를 읽은 진행자 답. 요청 글로 만든 카드면 null), goal, criteria, outOfScope, userDecides, review?:{ reviewerId, reviewerName, droppable:[{ index(팀 단계 번호), label, names, instruction(앞 120자) }] }(검수 줄, 결정 0015), prep?:{ direct, research:{ can, on, who:[{id,name}], min, max }, meeting:{ can, on, who, rounds, calls, checks } }(조사·회의 먼저 줄, 결정 0017), warn?, fallback?, status:'open'|'confirmed'|'cancelled', createdAt, confirmed?, edited?, prepChosen?:{ research, meeting }, checks?, keep?, reviewerReadOnly?, work?:{ can, why:''|'approve'|'meeting'|'few', on }, workChosen?, estimate?(호출 어림 조각 estimateParts: spent, cap, research, meeting, review, returns, cards, stages. 화면이 고른 값으로 더한다), providers?(구독 한도 줄에 보일, 팀원이 직접 정한 AI. 결정 0019), resolvedAt? }, 결정 0014 / kind 'plan': 계획 카드 { missionId, leadId, draftMsgId, cards:[{ id, title, ownerId, owner, kind, needs, done, files, not, solo }], waves:[[카드 id]], wavesText, fallback?, reassigned?:[{ id, from, to }] }(코드가 다듬은 일 카드. 넘기는 대화·기억에 싣지 않는다. 결정 0018) / kind 'research': 조사 노트 카드 { missionId, status:'done', total, missing, fallback?, questions:[{ id, text, agentId, status, msgId, excerpt(답 앞 1,200자), more }] }(코드가 묶는다. 넘기는 대화·기억에 싣지 않는다. 결정 0017)), agentId?, runId?, stageIndex?, text,
           mission?(사용자 말: 목표 차례로 돌 요청), missionNote?(사용자 말: 목표가 도는 동안 온 추가 지시. 넘기는 대화에서 빼고 [사용자 추가 지시]로만 간다. 기억에는 목표 실행이 끝날 때 넣고, local 은 받은 AI 로 정한다), goalDraft?(에이전트 답: 목표 카드 초안. 넘기는 대화·기억에 싣지 않고, 인수인계 메모 쓸 에이전트를 고를 때 답한 것으로 세지 않는다), goalBlock?:{ from, to }(그 답에서 읽은 oc-goal 블록 자리. 화면이 감춘다), review?:{ round, results:[{ id, verdict, evidence, text(코드가 가진 기준 문장) }], missing(판정 블록을 못 받음), retried?, quota?(사용량 한도로 끊긴 판정 답. 화면은 회차 대신 "한도로 중단", 결정 0019) }(에이전트 답: 목표의 기준 판정. 기억에 넣지 않는다. 결정 0015), reviewBlock?:{ from, to }(받은 oc-review 블록 자리. 화면이 감추고 기준표로), once?(에이전트 답: 한 번 실행으로 돈 차례. 기준 판정·일하기 전 조사·목표 실행의 회의 차례. 그 에이전트의 CLI 대화에 없어서 놓친 대화·인수인계 메모 자격을 셀 때 답한 것으로 세지 않는다. 목표 실행의 회의 차례(`meeting` 도 있음)는 넘기는 대화에 싣지 않는다), prep?:{ kind:'scan'|'questions'|'research'|'meeting'|'plan', qid?, questions?, retried? }(에이전트 답: 일하기 전 조사·회의. 기억에도 넘기는 대화에도 싣지 않는다. 결정 0017), researchBlock?:{ from, to }(받은 oc-research 블록 자리. 화면이 감추고 질문 목록으로), planBlock?:{ from, to }(받은 oc-cards 블록 자리), card?:{ missionId, id }(일 카드의 답. 그 목표가 살아 있는 동안 넘기는 대화에 싣지 않는다), cardTail?(끝의 두 칸을 다시 쓴 답), blockedBlock?:{ from, to, reason }(일 단계 답 끝의 oc-blocked. 화면이 감추고 "막힘: 이유"로. 결정 0018), handoffAsk?(사용자 말: 인수인계 메모를 써 달라는 정해진 요청. 대화·기억에 싣지 않는다), handoff?(에이전트 답: 인수인계 메모. 이어받는 다른 AI가 먼저 받는다. 결정 0008), local?(사용자 말: 보낼 때 계획의 AI가 모두 내 PC 모델이면 true, 클라우드 AI가 실제로 받으면 지운다. true 면 클라우드 AI로 넘기는 대화·기억에서 뺀다. 결정 0007), remembered?(사용자 말: 프로젝트 기억에 넣기 시작했음. 두 번 넣지 않는다), cut?(대기열에 있다가 앱이 꺼진 말. 다시 켤 때 기억에 넣고 지운다),
           meeting?:{ phase:'opinion'|'turn'|'research'|'judge'|'conclude'(옛 메시지는 'review'), round, rounds, opposer?:true }(회의 차례), verdict?:{ verdict:'agree'|'continue', reason }(진행자 판정에서 읽은 블록. 결정 0010),
           check?:{ question, from, to, status:'asked'|'answered'|'no-researcher'|'over'|'low'(목표의 남은 호출이 적어 조사를 끔, 결정 0017)|'failed' }(차례 답 끝에서 읽은 조사 질문 블록. 블록은 글에 남고 from·to 자리를 화면이 감춘다), checkOf?(조사 결과: 질문한 차례 메시지 id. 결정 0011),
           attachments:[{id,name,mime,size,path}], blocks:[Block], status:'streaming'|'done'|'error'|'stopped',
           usage?:{input,output,cacheRead,cacheWrite,cost,durationMs, partial?(true: 하위 에이전트 몫이 빠졌을 수 있다), sub?(주 에이전트 밖에서 쓴 토큰: 하위 에이전트 등. 결정 0012)}, createdAt }
Block    { id, kind:'tool'|'thinking'|'notice', name?, input?, output?, status:'running'|'done'|'error' }
Notes    (notes/<agentId>.json, 지운 에이전트는 <agentId>.removed.json. 결정 0013)
         { version:1, role:{ tasks:[{ id, title(1~80자), done(끝났다고 볼 기준, 0~200자), check(확인 방법, 0~200자)}](최대 8) },
           items:[{ id, kind:'method'|'pitfall'|'criterion'|'tool', text(1~400자, 글자 단위), source:{ type:'user'|'agent'|'web', ref(agent·web: 주소나 파일, user: 채팅에서 고른 글이면 chat:<세션 id>/<메시지 id>, 아니면 '') },
                    status:'draft'|'confirmed'|'archived'(user 는 만들 때 confirmed, agent·web 은 늘 draft. 삭제 없음.
                      바꿀 수 있는 길: agent·web 은 draft→confirmed·archived, confirmed→archived, archived→draft. user 는 confirmed↔archived. 되돌리기는 전 값으로),
                    helped, harmed, localOnly(채팅에서 고른 글은 서버가 그 메시지를 보고 정한다), createdAt, updatedAt }],
           log:[{ id, at, op:'add'|'edit'|'status'|'acceptAll'|'role'|'undo', itemId, before, after, undoOf? }](최근 200개) }
         시스템 지시에는 확정 항목만(내 PC 전용은 내 PC 모델에게만). 크기는 항목 글 + 찍는 출처 주소(바깥 자료만, 120자까지)로 센다.
         합이 2,000자 안이면 전부 최근 순, 넘을 때만 요청과 낱말이 겹치는 순 → helped − harmed → 최근 순으로 채운다.
         user 항목은 "사용자가 정한 것" 아래, agent·web 항목은 무작위 표식 안에 참고로. 항목 글·주소·하는 일의 < > 는 전각(＜ ＞)으로 바꿔 넣는다
Run      { id, cut?(실행 중에 앱이 꺼졌다는 표시. 다시 켤 때 그 사용자 말을 기억에 넣고 지운다), mission?:'goal'|'work', missionId?(목표 실행: 목표 차례 / 확인한 목표의 일), resumed?(끊긴 목표를 이어서 만든 일 실행. 결정 0016), teamId|null, status:'running'|'paused'|'waiting'|'done'|'error'|'stopped',
           stageIndex, hold?:{ reason:'pause'|'approve'|'error'|'mission'|'cap'|'quota', stageIndex, at, …(mission: kind 'verdict'|'notes'|'blocked'|'limit', round, left, notes, more?, reviewer?, extras?, keepBroken?, blocked?, cards? / cap: kind?'rate', used, cap, step / quota: phase 'work'|'review', until, passed?(이어서 할 때 저장된 시각이 이미 지남), canAuto, autos, autoMax, out:'skip'|'accept'(예전 출구), who:[{ agentId, name, provider, ai, error(AI가 보낸 오류 문구 300자, 화면에만) }], autoAt?(자동 이어서를 고른 뒤 다시 시작할 시각). 결정 0019) }, stages:[{ label, agentIds, status, mission?:'review'(목표의 기준 판정 단계)|'scan'|'questions'|'research'|'meeting'(일하기 전 대목, 단계표 맨 앞. 결정 0017)|'plan'|'cards'(일 카드의 계획 대목과 카드 단계. 결정 0018), cardIds?(그 단계의 카드), count?(조사 질문 수, 단계 띠의 ×n), note?, meetingNow?:null|{ phase, round, rounds, speakerId?(차례·조사 중인 사람), opposerId?(반대편이 있으면 늘), askedBy?(조사 중일 때 질문한 사람) }(회의 진행 표시. 결정 0010·0011) }], startedAt, endedAt }
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
  { type:'usage', input, output, cacheRead, cacheWrite, cost, tree? }   // tree: Claude 만. 결과의 { modelUsage, totalCost } 그대로(하위 에이전트 포함 누적). 이번 몫은 오케스트레이터가 정산한다(결정 0012)
  { type:'limits', provider, windows:{ five_hour?:{pct,resetsAt}, seven_day?:{pct,resetsAt}, primary?:... } }
  { type:'session', id }
  { type:'notice', text }
```

## 실행 엔진(오케스트레이터)
- 사용자 메시지 → Run 생성. 팀이 있으면 단계 순서대로, 한 단계 안의 에이전트는 병렬.
- 각 에이전트 프롬프트 = 역할 지시 + 팀 맥락 + (첫 단계면) 사용자 요청 / (다음 단계면) 사용자 요청 + 이전 단계 결과 + 개입 지시.
- 에이전트마다 CLI 세션 ID를 세션에 저장 → 다음 턴은 resume으로 이어감(기억 유지).
- `@이름` 멘션 → 그 에이전트에게만 보냄. 팀 없는 세션 → 단일 에이전트 채팅.
- 개입: steer(지시 추가: Claude는 실행 중 stdin 주입, 나머지는 턴 종료 후 이어서 실행. 목표의 기준 판정 중인 검수자와, 일하기 전 조사·회의나 목표 실행의 회의 차례(한 번 실행)에 있는 에이전트에게는 넣지 않고 목표의 추가 지시로 받는다), pause(현재 단계 끝나면 멈춤), resume, stop(프로세스 트리 종료), skip(현재 에이전트 중단 후 다음), retry(단계 재실행), approve/reject(승인 게이트, 거절 시 피드백 붙여 재실행). conclude(회의 단계에서 남은 바퀴를 건너뛰고 진행자가 바로 결론).

### 목표 모드(`server/mission.js`, 결정 0014)
- 켜기: 세션 PATCH `goalMode`. 팀 없는 세션, 내 PC 모델과 클라우드 AI(자동 라우팅은 어느 쪽으로도 셈)가 섞인 팀, 예약 실행·칸반 카드 세션은 400 과 이유(`missionProblem`). 요청이 목표가 될 때·확인할 때 다시 본다.
- `send`: @이름·인수인계·예약이 아닌 말은 지금 끼어들기·영입 감지보다 먼저 본다. 살아 있는 목표 없음 → 목표 차례 / 카드 대기 → 그 카드를 닫고 목표 차례 / 도는 중 → 추가 지시(`notes`) / 끊김 → 400. 초안을 쓰는 중에 온 말은 모드(지금 끼어들기·다음 차례로)와 상관없이 진행자에게(steer). 다른 실행이 돌면 대기열(`mission: true`). 영입 카드의 "그대로 보내기"(`sendProposed`)도 같다(살아 있는 목표가 있으면 409).
- 추가 지시(`#missionNote`): 그 뒤에 시작하는 단계들과, 승인·오류 대기 중에 왔으면 거절·다시 하기로 다시 도는 그 단계에 들어간다. 50개까지(넘으면 400). 검수자에게는 주지 않는다. 판정 뒤에 안 쓴 지시가 있으면 묻는다(결정 0015). 일 실행이 없을 때만 응답에 `late: true`. 기억에는 목표 실행이 끝날 때(앱을 끌 때·끊긴 목표를 다시 켤 때도) 넣는다: 받은 AI 가 모두 내 PC 모델이면 local, 클라우드 AI 가 하나라도 받으면 표시 없이, 아무도 안 받았으면 보낼 때의 팀 구성대로(`#received`·`#rememberNotes`).
- 목표 차례(`#goalTurn`): 진행자(첫 회의 단계 진행자 → analysis 역할 첫 팀원 → 첫 단계 첫 에이전트) 혼자인 단계 하나. 답 맨 끝의 ```oc-goal 블록을 읽고(`parseGoal`·`cleanGoal`), 못 읽으면 같은 실행에서 한 번 다시 요청, 그래도 안 되면 요청 앞 200자를 목표로 한 기준 없는 카드. 오류·중지·진행자 건너뛰기면 목표를 닫는다(오류·건너뛰기는 대화에 한 줄). 진행자의 `providerSessions`·`sessionProvider`·`usageBase`·`noteHashes` 는 시작 때 적어 두고 끝날 때 되돌린다(일 단계가 목표 차례의 CLI 대화를 이어 가지 않게).
- 확인(`confirmMission`): 화면이 보던 카드 전체(`expected`)를 저장된 초안과 글자까지 대조(`sameCard`), 검수 줄(`review: { reviewerId, droppable, drop }`, droppable 은 카드가 보여 준 번호·이름·담당·지시 목록)을 지금 팀으로 다시 계산한 값과 글자까지 대조(다르면 409 + `review`, 없으면 아무것도 안 뺀다). 확정하면 실행 하나(`#missionPlan`: 사용자가 남기지 않은 검수 단계를 빼고, 검수자가 있으면 맨 끝에 기준 판정 단계). 실행을 먼저 넣고 저장한다(도는 목표가 도는 실행 없이 저장되지 않게). 각 단계 지시의 맨 앞에 "확정된 목표와 합격 기준" 블록(`#goalCardPrompt`, < > 는 전각). 그 앞에는 지금처럼 프로젝트 기억·인수인계 메모·놓친 대화, 이어 갈 대화가 없는 에이전트면 `[이전 대화]`가 붙는다. 일 단계는 `#missionRun`·`#missionWork` 가 돌린다(단계 본문은 목표 모드가 아닌 실행과 같은 `#runStage`).
- 새 눈 검수(`#reviewStage`, 결정 0015): 검수자(`reviewPlan`: 팀의 검수 단계 에이전트 중 진행자가 아닌 첫 사람 → 진행자도 마지막 일 단계 담당도 아닌 첫 팀원 → 없음. 팀 밖에서 고르지 않는다)를 한 번 실행(`#runAgent` 의 `once`)으로 돌린다: 대화 번호·사용량 직전 누적·역할 노트 해시를 읽지도 쓰지도 않고, 프롬프트는 `reviewPrompt` 만(앞 대화·기억 없음), 질문 창·밀린 지시 없음, 기억에 안 넣는다. 답 맨 끝의 ```oc-review 블록을 일회용 값과 기준 id 로 읽고(`parseReview`), 못 읽으면 새 값으로 한 번 다시, 그래도 안 되면 판정 없음(전부 unknown). 결정 0015 개정(2026-11-22): 기준마다 확인 방법·바뀌면 안 되는 것을 프롬프트에, 기준에 걸리면 사소해도 fail·근거 없는 fail 은 unknown·기준 밖은 `extras`(막지 않음)·지킬 것 어김은 `keepBroken`(묻는다), 작업 폴더가 git 이면 `git status --porcelain` 50줄을 표식 안에(테스트 파일이 바뀌면 진행 기록), 형식을 두 번 놓친 판정은 구멍(`fail: 'hole'`), 두 번째 되돌림·같은 기준 연속 불합격이면 되돌림 프롬프트에 "[가정 적기]".
- 판정 뒤(`#missionRun`): 중지 → stopped / 안 쓴 추가 지시 → 묻기(`hold.reason: 'mission'`, kind notes) / 전부 통과 → done / 불합격이 있고 되돌림이 남음 → 마지막 일 단계를 걸린 기준 블록(`returnPrompt`, 무작위 표식)과 함께 다시(그 단계의 직전 결과도 표식 안의 참고로. 이어 가는 대화에 이미 있으면 빼고. 회의면 진행자 혼자 결론을 받아, 승인 단계면 승인을 다시 묻는다. 그 뒤 단계는 다시 안 돌고 다음 검수 자료에서 옛 답을 뺀다) → 다시 검수 / 그 밖 → 묻기(kind verdict: 받아들이기 accepted · 한 번 더 · 그만). "한 번 더"는 되돌림 한 번(`returnCap = returns + 1`). 단계 앞마다 호출 상한(`#capCheck`, `hold.reason: 'cap'`, 20번 더 · 그만). 검수자가 없으면 판정 없이 묻는다("한 번 더" 없음, 그 대기 중 추가 지시는 late). 회의 단계는 회의 호출 수 식(`meetingCalls`)으로 상한을 검사한다(결정 0017). 단계 안의 다시 시도·이어받기와 회의 중 조사는 상한을 넘을 수 있다. 검수 답·목표 초안은 그 에이전트가 답한 것으로 세지 않는다(놓친 대화·`#historyList`·인수인계 메모 쓸 사람). 기준 판정 중(또는 그 차례의 한도 대기 중)인 에이전트를 골라 보낸 지시와, 일 실행 중 일하지 않는 에이전트에게 보낸 지시는 목표의 추가 지시가 된다.
- 진행 기록(`logLine`): 목표 초안·확인(검수자·건너뛴 단계)·단계 시작/다시/끝·추가 지시·검수 결과·되돌림·물은 것과 답·상한·끊김·이어서·버림·끝. 다시 켜면 `#fixStale` → `cutMission`(초안 쓰던 목표는 닫고, 도는 중·대기는 `cut`, 끊긴 자리 `at` 은 그대로). 저절로 다시 돌지 않는다.
- 이어서(`resumeMission`, 결정 0016): 사용자가 누를 때만. `cut` 이고 도는 실행이 없고 팀 검사(`missionProblem`, 아니면 400)를 지나고 요청 메시지·`at`·`keep`·끊긴 실행 기록이 있어야 한다. 확정 때의 작업 폴더(`cwd`)·역할 종류(`roles`)와, 지금 팀과 `keep` 으로 다시 만든 `#missionPlan` 이 끊긴 실행과 단계 수·기준 판정 자리·라벨·담당(순서)·승인·회의 여부·회의 설정(바퀴 수·진행자·반대편·사용량 상한)·단계 지시·검수자가 같아야 한다(`stageDiff`, 아니면 409 와 무엇이 다른지. 에이전트의 AI·권한은 대조하지 않는다). 새 일 실행(`resumed`) 하나를 끊긴 자리(`resumePoint`)부터 돈다(`#missionRun(ctx, from)`): 일 단계면 그 단계부터(`finished` 의 답은 그대로 쓰고 그 사람은 다시 안 돈다. 회의는 1바퀴부터), 되돌림이면 그 되돌림을 걸린 기준·직전 결과와 함께(되돌림 수는 다시 안 센다), 기준 판정이면 판정부터(같은 회차), 승인·오류 대기면 저장된 답(과 오류 줄)으로 호출 없이 같은 질문부터(`#runStage` 의 resume. 거절·다시 하기는 단계 전체), 판정 뒤 묻기·호출 상한이면 호출 없이 같은 질문. 앞 단계 결과는 이 목표의 일 실행들의 메시지에서 다시 모은다(`pastOutputs`: 단계·에이전트마다 가장 최근의 끝난 답, 회의는 결론 또는 되돌림에서 진행자 혼자 고친 답. 검수 답·목표 초안·인수인계 메모는 뺀다. 못 찾은 단계는 이름을 적고 건너뛴 단계는 세지 않는다). 끊긴 일 단계의 `working` 에이전트는 `providerSessions`·`sessionProvider`·`usageBase`·`noteHashes` 를 지우고 새 대화로, 그 단계에서 각자의 첫 호출 프롬프트 맨 앞에만 "[이어서] …" 한 줄(`ctx.resumeAt`). 회의 단계는 아무의 대화도 지우지 않고 "[이어서]" 도 안 붙인다(결정 0017부터 목표의 회의 차례는 늘 한 번 실행이라 1바퀴부터 다시 할 뿐). 기준 판정 중 끊긴 검수자는 건드리지 않는다(한 번 실행). 호출 수·되돌림 수·회차·판정·쓴 추가 지시(`liveNotes`)는 저장된 값에서 이어 간다. 실행 기록을 30개로 자를 때 살아 있는 목표의 일 실행은 남긴다. 앱을 정상으로 끌 때(`stopAll`)는 끄는 중 표시(`closing`)로 `#missionEnd` 가 목표 상태를 바꾸지 않는다(다시 켜면 `cut`). 세션을 디스크에서 읽을 때 멈춘 실행의 도는·승인 대기 단계는 `stopped` 로(`#fixStale`, 목표가 아닌 실행도).
- 일하기 전 조사와 회의(결정 0017): 목표 카드의 `prep`(`prepCard`: 조사 담당 = 팀의 research 역할 전원, 참석자 = 진행자 + build·review 가 아닌 팀원 최대 5명, 기본 켜짐, 진행자가 블록에 `"direct": true` 를 쓰면 기본 꺼짐, 못 하는 대목은 잠김, 진행자 `lead: { id, name, inTeam }` 가 팀에 없으면 두 대목 다 잠김, 어림값). 확인 본문의 `prep: { research, meeting, lead, researchers, attendees }` 를 지금 팀과 대조(`prepFits`, 진행자·명단이 다르면 409 + `prep`, 없으면 조사·회의 없이). 고른 대목은 `#missionPlan` 이 단계표 맨 앞에 붙인다(`mission: 'scan'|'questions'|'research'|'meeting'`). `#prepRun` 이 차례로: 훑어보기(`#scanStage`, 조사 담당 첫 사람) → 조사 질문(`#questionsStage`, 진행자의 ```oc-research 블록 `parseResearch`, 못 읽으면 한 번 다시, 그래도 안 되면 질문 하나) → 조사(`#researchStage`, 질문마다 한 번, 사람끼리 동시에·한 사람 것은 차례로, 실패·빈 답·건너뛰기는 그 갈래만 "확인 못 함". 프롬프트에 다른 갈래가 맡은 질문 목록(같은 표식 안)과 "- 사실 | 출처 | 확인함·확인 못 함" 줄 형식) → 조사 노트 카드(`#researchCard`) → 준비 회의(`#prepMeeting`, 지금 회의 엔진을 `#runStage` 로, 2바퀴). 조사는 질문을 시작하기 전마다 일시정지·중지를 본다(`#prepPause`, 조사 담당이 여럿이어도 대기 하나). 대상 없는 건너뛰기는 그때 도는 질문만 건너뛴다. 모든 차례는 한 번 실행(`#runAgent` 의 `once`, `msg.prep`·`msg.once`, 기억에 안 넣음). 훑어보기·조사 질문·조사와 목표 실행의 회의 차례(준비 회의·팀 회의 단계의 의견·차례·판정·결론·회의 중 조사)는 그 실행만 `permission: 'plan'`(+ `readOnlyRun: 'research'|'talk'`, 시스템 지시의 권한 문장을 AI의 `caps.permissions`·`caps.tools`에 맞추고 규칙 파일 줄은 뺀다)으로 돈다. 이어받기 뒤에도 그대로. 기준 판정·일 단계와 저장된 에이전트는 그대로. 조사 노트(`answerFlags`)는 지시처럼 보이는 줄(`instructionLine`: `strip` 뒤 0013 의 `INJECTION` 무늬 중 시키는 꼴만)과 출처 없는 목록 줄(주소·`파일:줄`·`경로/파일.확장자`가 없는 줄)을 세서 카드(`suspect`·`unsourced`, 질문마다도)와 노트 머리에 싣고, 일 단계 노트에서는 그 줄만 빼고(`dropInstructionLines`, 뺀 줄 수 한 줄) 회의 노트에는 경고를 단다. 카드의 `textOnly`(도구는 있는데 읽기 전용을 못 막는 AI)·`noTools`(도구 없는 AI)는 이어받기 사슬(`msg.aiChain`)까지 본다(`researchGuards`). 목표 회의 중 조사 결과 메시지에도 `flags`·`textOnly`·`noTools`. 준비 대목 답과 목표의 회의 차례는 넘기는 대화(`#historyList`·`#withHistory`·`#withMissed`·`#fullTalk`)에서 뺀다(`notTalk`). 목표 팀 회의 차례는 기억에 들어가고, 자기 CLI 대화를 이어 가는 에이전트에게도 `#recall` 이 그 사람의 한 번 실행 답은 빼지 않는다(대화에 없으니까). 목표 일 실행의 회의 차례(준비 회의와 팀의 회의 단계, 회의 중 조사 포함)도 `#runAgent` 가 `ctx.meet` 를 보고 한 번 실행으로 돌린다(프롬프트는 `#prompt` 의 fresh: 앞 대화 없이). 조사 노트(`researchNote`, 답마다 앞 1,200자)는 준비 회의와 일 단계에, 회의 결론(`conclusionPrompt`, 앞 2,000자)은 일 단계에 무작위 표식 안의 참고 자료로(`#prepRefs` 가 목표의 메시지 id 로 다시 만든다). 기준 판정·[이전 단계 결과]·`#reviewedBy` 에는 준비 대목을 넣지 않는다. 추가 지시는 일 단계부터. 대목 앞마다 호출 상한(훑어보기·질문 1, 조사는 안 끝난 질문 수, 회의는 `meetingCalls`). 목표 실행의 회의(준비 회의·팀 회의 단계)는 의견 끝에 입장 줄, 차례 발언에 이견을 먼저 적고 입장을 바꾼 이유를 적으라는 말, 차례·판정·결론에 "[네가 앞에서 한 말]"을 남의 말과 따로(경고 문장도 그렇게), 반대편에는 가장 강한 주장을 근거로 반박하라는 말을 넣는다(`#meetingPrompt` 의 `goalMeet`). 건너뛸 차례가 판정 한 번보다 많이 들면(`firstJudge`) 1바퀴 뒤에 진행자가 반대편을 포함한 모두의 입장이 같은지 판정하고(`meet.first`), 합의면 차례 바퀴 없이 결론(진행 기록 한 줄). 차례 바퀴 뒤 판정은 지금처럼 반대편을 뺀다. 호출 수 식에 그 판정을 넣고(`meetingCalls`), 합의로 줄어든 수는 `meetingCallsMin`(카드의 `meeting.fewer`). 목표 안의 팀 회의 단계도 `meetingCalls` 로 본다(끊긴 회의를 이어서 할 때도 1바퀴부터라 같은 식. 회의 아닌 단계를 이어서 하면 다시 돌릴 사람 수). 남은 호출이 상한의 4분의 1 아래면 목표 회의의 회의 중 조사를 끈다(`check.status: 'low'`, 회의마다 진행 기록 한 줄). 끊김: `at.phase` 가 준비 대목이면 그 대목부터(끝난 대목은 안 돌고, 조사는 안 끝난 질문만, 회의는 1바퀴부터, 호출 상한 대기만 다시 묻는다).
- 일 카드(결정 0018): 목표 카드의 `work`(`workCard`/`cardsProblem`: 승인 관문·회의 단계가 있거나 검수 역할이 아닌 팀원이 한 명 이하면 못 씀). 확인의 `work: 'cards'` → 단계표 = [준비 대목…][계획 `mission:'plan'`][빈 일 자리][기준 판정]. 계획(`#planStage`): 진행자 한 번 실행(읽기 전용, `prep: { kind:'plan' }`)으로 맨 끝 ```oc-cards 블록 → `cleanPlan`(2~6장, k1… 번호는 코드, needs 는 앞 카드만) → `matchOwners`(없는 이름이면 한 번 다시, 그래도 없으면 `fallbackOwner`) → 블록을 못 읽으면 한 번 다시, 그래도 안 되면 카드 하나 → `mission.cards`, 빈 자리를 `waveStages(planWaves(cards))`로 바꾸고 계획 카드. 단계 나누기: needs 가 앞 단계에서 끝난 카드끼리, 같은 담당은 한 단계에 하나, files 가 겹치면 다른 단계, 파일 없는 build·write 카드는 혼자. 카드 단계는 `#runStage` 그대로(보통 실행), 담당마다 `cardPrompt`(표식 안 카드 글 + 기다린 카드의 꼬리·결과 1,500자) + 끝의 두 칸(`tailRule`) + 막힘 출구(`blockedRule`, 단계표 방식 일 단계에도). `#cardGate`: 되풀이 상한(카드 하나 3번, 넘으면 `hold mission/limit`)과 시간당 시작 수(20장, `hold cap/rate`). `#cardsAfter`: 상태·꼬리(없으면 한 번 다시, 그래도 없으면 hole)·막힘. 막힘(`#blockedOf`·`#blockedAsk`, `hold mission/blocked`): 받아들이기 = 막힌 일만 빼고(카드는 hole, by 'blocked', 답에 blockedBlock.accepted) 나머지로 판정까지 / 한 번 더 = 막힌 사람만 / 그만. 오류 다시 하기는 오류 난 카드만. 되돌림은 마지막 카드 단계. 이어서: `at.phase 'plan'` 이면 계획부터, 그 뒤면 저장된 카드로(다시 계획하지 않는다), 카드 담당이 팀에 없거나 일 카드를 못 쓰게 되면 409.
- 호출 어림과 한도 대기(결정 0019): 목표 카드에 `estimate`(`estimateParts`: 목표 잡기에 이미 쓴 호출, 조사 3~8·회의(1바퀴 합의 수~회의 호출 수 + 회의 중 조사 최대 3)는 `prepCard` 값, 단계표면 팀 단계마다 인원(회의 단계는 `meetingCallsMin`~`meetingCalls`, 되돌림 때는 진행자 1명)과 검수 단계 여부·뺄 수 있는지, 일 카드면 계획 1 + 카드 1~6장과 마지막 카드 단계 최대 명단 수, 검수자가 있으면 판정 1과 자동 되돌림 `RETURN_CAP`)과 `providers`. 화면과 서버는 같은 `sumEstimate`(public/js/mission-numbers.js)로 더한다: 남은 단계 = 빠질 수 있는 단계 중 남긴 것만, 되돌릴 단계 = 남은 단계 중 검수 단계가 아닌 마지막(없으면 남은 마지막. `reviewPlan` 과 같다), 최대 = 최소 + 되돌림 × (그 단계 + 판정). 팀이 바뀌어 확인이 409 면 지금 팀의 조각(`estimate`)도 준다. 확인 요청은 화면이 보던 범위(`estimate: { min, max }`)도 보내고, 지금 팀으로 다시 센 값과 다르면 같은 409(다른 대조에 안 걸리는 팀 변경. 없는 요청은 대조하지 않는다). 확인할 때 `estimateCalls` 로 `mission.estimate` 를 적고, 끝난 카드(done·accepted·stopped)는 실제 `calls.used` 옆에 보인다. 구독 한도 줄은 화면이 이미 받은 `state.usage.limits` 에서 `limitRows`(사용률이 숫자이고 초기화 시각이 없거나 미래인 창만, 창 이름은 세션 화면의 `WIN_LABEL`, 기록 나이는 `recordAge`: 분·시간·일, 하루 넘으면 오래된 기록)로 그리고 새로 읽지 않는다. 한도 대기: 목표 일 실행의 일 단계(단계표·카드, 준비 대목·회의 단계·계획은 빼고)에서 실패한 사람이 모두 `isQuotaError` 이거나(이어받기가 다 실패한 뒤) 기준 판정이 한도로 끝나면 `#quotaAsk` 가 `hold.reason: 'quota'` 로 묻는다. 초기화 시각(`#quotaUntil`): 한 사람마다 마지막으로 실제로 돈(한도에 걸린) AI 의 `limitResetAt`(100% 이상이거나 거절 기록의 창만. 이어받기 기준 95%가 아니다)과 `resetFromText` 중 늦은 쪽, 없으면 오류 문구로 표시한 `Cooldown`(source 'text'), 사람끼리는 늦은 쪽, 한 사람이라도 모르면 0(이어서 할 때는 저장된 시각, 지났으면 `passed`). 보기 순서: later(시각을 알 때만) · retry · skip(일 단계)/accept(판정) · stop. later 면 `quotaDelay`(그 시각 + `QUOTA_SLACK` 45초, `OFFICE_CREW_FAKE_ONLY` 가 켜졌을 때만 `OFFICE_CREW_QUOTA_RESUME_MS`)의 메모리 타이머(`quotaTimers`, 대기가 끝나면 지운다)가 retry 를 보낸다(같은 `hold.at` 으로 다시 띄워 알림을 다시 보내지 않는다). 타이머가 울릴 때 일시정지를 눌러 뒀으면 일시정지 대기부터(거기서 그만이면 사무실 표시도 '중지됨'으로). 다시 하기 앞에 `#capCheck`(모자라면 "20번 더", 끝낸 답은 끊긴 자리에 남긴다). 자동은 실제로 다시 시작할 때만 세고 `QUOTA_AUTO`(3)번까지(`mission.quota.autos`). retry 는 일 단계면 한도에 걸린 사람만 다시 돌고 끝낸 답은 그대로(일 카드는 카드 시작 수·시간당 수에 세지 않는다), 판정이면 같은 회차를 처음부터(한도로 끊긴 판정 답은 `review.quota`). skip 은 오류 대기의 skip 과 같고 일 카드면 그 카드를 구멍(`by: 'quota'`, 뒤 카드엔 결과 없음, 검수 자료엔 빈 결과라는 코드의 줄. 줄은 카드 표시로 만들고 그 담당의 답은 결과로 넣지 않는다. 카드가 전부 그렇게 빠진 카드 단계는 건너뜀). accept 는 이번 회차를 판정 없음으로 적고 받아들임으로 끝낸다(`ctx.quotaAccept`). stop 이면 사무실 표시를 '중지됨'으로. 진행 기록 `quota`(fail outside)·`answer` 줄. 끊긴 자리 `wait: { reason: 'quota', until, failed }`: 이어서 하면 호출 없이 같은 대기를 다시 띄운다(일 단계는 `#runStage` 의 resume, 판정은 `#missionRun`. 저장된 오류 문구로 한도인지 다시 판정하지 않는다). 다시 하기 앞 상한 대기는 `wait: { reason: 'cap', quota: true }`(이어서 하면 끝내지 못한 사람만 다시 돌고 일 카드는 `#cardGate` 를 건너뛰어 시작 수에 세지 않는다). 사이드바·알림 종류 `quota`.

### 이어갈 대화(resume)
- `providerSessions[agentId]`에 CLI 대화 id, `sessionProvider[agentId]`에 그 대화를 만든 프로바이더를 같이 저장한다. 지금 실행할 프로바이더가 다르면(자동 라우팅·이어받기로 바뀜) 이어하기를 하지 않는다.
- 이어갈 대화가 없거나 이어하기가 실패하면, 이 세션의 최근 대화(이번 실행의 앞 단계 결과는 제외)를 `[이전 대화]`로 프롬프트 앞에 넣어 맥락을 잇는다.

### 세션 불러오기(`server/importer.js`)
- `GET /api/import/list?q=` → Claude Code(`~/.claude/projects/*/<id>.jsonl`)·Codex(`~/.codex/sessions/**/rollout-*.jsonl`) 기록 목록(앞·뒤 64KB만 읽어 제목·미리보기, 못 찾으면 512KB까지 더 읽음, mtime 캐시).
- `POST /api/import {source, id}` → 대화를 앱 메시지로 옮긴 새 세션(원래 폴더가 있으면 그 폴더), 전용 에이전트 `import-claude`·`import-codex`, `providerSessions`에 원래 대화 id.
- Claude는 첫 이어하기 때 `--resume <id> --fork-session`으로 갈래를 만들어 원래 기록 파일을 그대로 둔다. Codex `exec resume`엔 갈래 옵션이 없어 같은 스레드에 이어 붙는다.

### 자동 이어받기(`server/failover.js`)
- 실행 중 오류가 한도 문구(`isQuotaError`)면: 그 프로바이더를 쉬게 표시(`Cooldown`, 초기화 시각을 모르면 30분. 어디서 안 시각인지 `source`('limits'·'text')에 적는다, 결정 0019) → 같은 역할·프로필로 라우팅 엔진에 다시 물어 다른 AI를 고름(`pickFallback`, 이미 시도한 AI 제외) → `continuationPrompt`(원래 요청 + 지금까지 쓴 글)로 같은 메시지에 이어서 실행. 여러 번 연쇄 가능.
- 실행 전: 직접 설정 에이전트의 AI가 쉬는 중이거나 한도 사용률이 기준(`failoverThreshold`, 기본 95%) 이상이면 이번 실행만 대체 AI로. 자동 라우팅은 막힌 AI를 빼고 고른다(전부 막히면 원래 목록으로 시도).
- 설정: `failover`(기본 켬), `failoverThreshold`, `waitForResetMin`(0~30분, 기본 0 = 끔: 직접 정한 AI의 다 찬 창이 이 안에 풀린다고 한도 기록이 알려 주면 실행을 시작할 때 다른 AI로 넘기지 않고 기다렸다가 같은 AI로 한다. 기다리는 동안 에이전트 상태는 `paused`). API: `GET /api/cooldown`, `DELETE /api/cooldown/:provider`. 이벤트: `cooldown`.
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
notes {agentId, drafts}            역할 노트가 바뀜(drafts: 받지 않은 초안 수)
mission {sessionId, goalMode, mission}  목표 모드나 목표가 바뀜(세션 요약 이벤트에는 안 실린다. 결정 0014)
```
agentState.state ∈ idle | thinking | typing | tool | searching | reading | running | waiting | error | done | paused | offline

## REST API(모두 토큰 필요)
```
GET  /api/bootstrap                  agents(에이전트마다 noteDrafts·noteCount: 역할 노트 초안 수·확정 수), teams, sessions(메타), settings, providers, usage, skills, connectors, plugins
GET  /api/providers?refresh=1        탐지 결과
POST /api/providers/:id/login        로그인용 터미널 창 열기
GET  /api/providers/:id/models
POST·PUT·DELETE /api/agents, /api/teams, /api/connectors, /api/skills (목록은 bootstrap), DELETE /api/plugins/:id
                                     에이전트를 지우면(플러그인을 지워 빠질 때도) 역할 노트 파일은 이름만 <id>.removed.json 으로
GET  /api/agents/:id/notes           역할 노트 전체(결정 0013). 없는 에이전트 404, 형식 오류 400(이유), 되돌릴 수 없는 변경 409
PUT  /api/agents/:id/notes/role      {tasks}
POST /api/agents/:id/notes/items     {kind, text, source(꼭 필요: {type, ref?}. 없으면 400), localOnly?(불리언만)}
                                     source 가 {type:'user', ref:'chat:<세션 id>/<메시지 id>'} 면 그 메시지를 찾아(못 찾으면 400) 내 PC 모델 답이면 localOnly,
                                     글은 주입 무늬 검사(걸리면 400 과 편집 창에서 직접 쓰라는 안내)
PATCH /api/agents/:id/notes/items/:itemId  {text?, kind?, status?(위 상태 길만. 그 밖은 400)}
POST /api/agents/:id/notes/accept-all, POST /api/agents/:id/notes/undo {logId}
GET  /api/sessions/:id               전체 세션
POST /api/sessions                   {title?, teamId?, agentId?, cwd?}
PATCH/DELETE /api/sessions/:id
POST /api/sessions/:id/messages      {text, attachments:[id], mention?}  목표가 도는 중이면 → {noted, messageId, late?}(결정 0014)
POST /api/sessions/:id/control      {action, runId?, agentId?, text?}  목표의 판정 뒤 묻기(mission)·호출 상한(cap) 대기에는 accept·more·stop(결정 0015), 한도 대기(quota)에는 later(초기화 뒤 자동 이어서. 시각을 알고 3번이 안 찼고 아직 안 골랐을 때만)·retry(지금 다시)·skip(일 단계만)·accept(판정만)·stop(결정 0019). 확인 409 에는 지금 팀의 어림 조각 estimate 도 싣는다. 대기 사유에 맞지 않는 동작은 {ok:false}
PATCH /api/sessions/:id {goalMode}   목표 모드 켜기·끄기(쓸 수 없으면 400 과 이유, 살아 있는 목표가 있으면 끄기·teamId 변경 409. 쓸 수 없는 팀으로 바꿔 저절로 꺼지면 응답에 goalModeOff: 이유. 결정 0014)
POST /api/sessions/:id/mission/confirm {missionId, expected:{goal, criteria, outOfScope, userDecides, checks?, keep?}, edited?, review?:{reviewerId, droppable:[카드가 보여 준 목록], drop:[팀 단계 번호]}, prep?, work?:'cards'|'stages', estimate?:{min, max}(화면이 보던 호출 어림, 결정 0019)}
                                     본 것과 저장된 초안이 다르면 409 + {draft}, 검수 줄이 지금 계산과 다르면 409 + {review}(결정 0015), 일 카드를 지금 팀으로 못 쓰면 409 + {work}(결정 0018). 옛 목표·처리한 카드·실행 중·마지막 카드 아님·카드 뒤 사용자 말은 409, 기준 0개·섞인 팀은 400
POST /api/sessions/:id/mission/cancel {missionId}   카드 대기 목표 닫기,  POST …/mission/discard {missionId}  끊긴 목표 버리기
POST /api/sessions/:id/mission/resume {missionId}   끊긴 목표를 끊긴 자리부터 이어서(결정 0016). 다른 목표·cut 아님·실행 중·요청 없음·끊긴 자리 없음·끊긴 실행 기록 없음·팀이 바뀜(이유: 무엇이 다른지)은 409, 섞인 팀은 400
POST /api/sessions/:id/proposals/:mid  영입 제안 카드만(kind 가 hire 가 아니면 409)
POST /api/sessions/:id/handoff      {agentId?} 인수인계 메모 쓰게 하기(AI 호출 1번, 결정 0008). 쓰는 중이면 409
                                    데이터 폴더의 handoff/<세션>/ 에 불러온 대화 원문(import.jsonl)과 다른 AI에게 건네는 대화 전체 파일(cloud/)을 둔다(server/handoff.js)
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

## 세션 화면 위쪽 그림(결정 0020)
- 보기(`settings.viewMode`): `split`(기본) = 흐름 무대(`FlowStage`, 156px, 손잡이로 120~240px, 140px 아래는 작은 모양, 높이는 `ui.stageH`) / `chat` = 접은 한 줄 띠(`StageStrip`, 30px) / `office` = 마을·스킨 그림(`VillagePanel`, 아래 계약). `session.js` 의 `OfficePanel` 이 보기에 따라 둘 중 하나를 그려서, 마을은 `office` 보기에 들어갈 때 만들어지고 나올 때 치워진다. 흐름 무대는 스킨이 아니다(`settings.skin` 기본값 `village` 그대로).
- 아래 진행 바(`RunBar`): `office` 보기만 단계 띠를 그리고, `split`·`chat` 은 일시정지·재개·중지·회의 끝내기와 기억·사용량만(`.runbar.thin`).
- 모델(`stageModel({ run, live, mission, questions, agents, team, solo, conn, now, prev, request })`): 역 = 마지막 실행의 단계(실행이 없으면 팀 단계표를 할 일로, 팀이 없으면 에이전트 하나, 목표 카드 확인 대기면 팀 단계표를 할 일로). 역 상태 todo·run·done·wait·limit·error·skipped·stopped·cut(목표의 판정 뒤 묻기·한도 대기 단계는 wait, 자동 이어서를 고른 한도 대기는 limit, 끊긴 목표의 멈춘 단계는 cut). 사람 상태는 지금 역(과 대기가 가리키는 역)에만: think·write·tool(search·read·run·edit·other)·meet·wait·limit·error·done·off·idle, 회의는 `meetingNow` 로 진행자·반대편·말하는 사람·조사하러 간 빈자리. 역마다 4명(넘으면 +n), 역 6개를 넘으면 지금 역 하나 앞까지 남기고 지난 역을 접는다. 내 차례(`ask.kind`)와 문 자리(서버가 묻는 때): approve = 그 단계 뒤, verdict·notes = 판정 역 뒤, blocked = 막힌 일 단계 뒤, cap·limit(카드 되풀이 상한) = 그 단계 앞(역을 기다림으로 칠하지 않는다. 한도 대기 뒤 다시 하기 앞의 cap 만 그 역 안), error·quota·question = 역 안, confirm = 맨 앞, cut = 전체 점선, paused = 알약만. "지금" 줄·한도 알약은 지금 단계·대기 단계의 담당과 조사 간 사람만 본다. 지워진 에이전트는 "삭제된 에이전트"(누를 수 없음). `prev` 와 지금 단계가 다르면 `fly`(hand, 거꾸로면 ret).
- 내 차례 알약·문을 누르면 답 창(채팅 안의 승인·오류·목표 대기 창, 입력창 위 질문 창, 끊긴 목표 알림, 목표 카드)으로 내려 그 창 자체에 초점(`tabindex=-1`, 보이는 테두리. 첫 단추에 두지 않는다). 찾는 클래스 이름은 `ANSWER_BOX`(테스트가 session.js·mission.js 원문과 대조). 역은 최소 너비가 있고, 넘치면 역 줄만 가로로 밀어 지금 역(없으면 문)을 보인다(창 크기가 바뀌어도). 움직임은 카드 날기(0.9초)와 내 차례 맥박뿐이고 움직임 줄이기면 멈춘다. 색은 앱 테마 변수에서만 섞는다(`public/css/stage.css`). 시험: `test/stage-model.test.js`.

## 사무실 렌더러 계약(public/js/office/index.js)
```js
createOffice(container, { skin, reducedMotion, onSelect(agentId), onCard(messageId) }) -> office
office.setAgents([{ id, name, role, model, color, avatar }])   // 책상 자동 배치(최대 12)
office.setState(id, { state, text, tool, tokens, badge, meeting, errand })  // 상태별 애니메이션. meeting: 회의 참석 중이면 모임 자리(마을 광장·회의실)로
                                                               // errand: 'search'|null 회의 중 조사(조사 자리로 갔다가 돌아옴. 참석자면 모임 자리를 "조사 중" 표로 맡아 둠)
office.setMeeting({ phase, round, rounds, speakerId, opposerId } | null)  // 말하는 사람(speakerId, 의견 단계는 참석자 모두)만 말풍선·끄덕임, 나머지는 그쪽을 봄,
                                                               // 반대편 이름표 표시, 모임 자리 이름표에 "회의 2/3 · 차례"
office.setBoard([{ id, text }], { quiet }?)                    // 모임 자리 옆 회의 결론 게시판(최대 3장, 왼쪽이 새것). 새 카드는 한 번 눈에 띄게(quiet 면 없이),
                                                               // 카드(button)를 누르면 onCard(id)
office.handoff(fromId, toId, label) -> Promise                 // 서류 들고 걸어가 전달
office.setSkin(skinIdOrObject); office.select(id|null); office.destroy()
SKINS (내장 4종: 크루 마을·모던·코지·나이트 + custom: 배경 이미지 + 책상 좌표)
createSkinEditor(container, { skin, onSave(skinObj), onCancel })
```
SVG 아이소메트릭(2.5D) 일러스트, CSS transform 애니메이션, 탭 숨김 시 정지, 줄이기 모드 지원.
회의 장면 계산(그림에 넘길 회의 상태 `meetingView`, 말하는 사람 `isTalking`, 조사하러 간 사람 `researcherOf`, 결론 카드 글 `cardText`·`boardCards`)은 DOM 없는 `public/js/office/meeting.js`(시험: `test/meeting-scene.test.js`).
