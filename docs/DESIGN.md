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
server/store.js             JSON 저장소(원자적 쓰기, 디바운스). 켤 때 옛 데이터 이전 처리(없앤 데모 팀·데모 에이전트 정리는 한 번만, 결정 0021)
server/bus.js               SSE 이벤트 허브
server/orchestrator.js      실행(run) 엔진: 단계 진행, 병렬, 승인 게이트, 개입
server/ask.js               에이전트가 사용자에게 묻기: 답 끝의 oc-ask 블록 읽기, 답을 돌려주는 글(결정 0009)
server/meeting.js           회의 차례: 반대편 고르기, 차례 순서, 진행자 답 끝의 oc-verdict 판정 블록 읽기(결정 0010), 차례 답 끝의 oc-check 질문 블록 읽기와 조사 담당 고르기(결정 0011)
server/notes.js             역할 노트: 에이전트마다 하는 일·항목·변경 기록 파일, 바깥에서 온 항목의 주입 무늬 거르기, 되돌리기, 시스템 지시에 넣을 항목 고르기(결정 0013)
server/mission.js           목표 모드: oc-goal 목표 카드 블록 읽기·다듬기, 본 카드와 저장된 초안 대조, 진행자 고르기, 내 PC 모델 섞임 검사, 진행 기록, 끊김 표시(결정 0014). 끊긴 목표 이어서의 단계표 대조·끊긴 자리 읽기·앞 단계 결과 다시 모으기(결정 0016). 일하기 전 조사와 회의의 조사 담당·참석자 고르기, 회의 호출 수 식, oc-research 조사 질문 블록, 훑어보기·질문·조사 프롬프트, 조사 노트·회의 결론 블록(결정 0017). 일 카드의 oc-cards 계획 블록 읽기·다듬기, 담당 대조, 단계(물결) 나누기, 계획·카드 프롬프트, 끝의 두 칸·oc-blocked 막힘 블록(결정 0018). 호출 어림 조각(estimateParts·estimateCalls), 한도 대기의 끊긴 자리 읽기(결정 0019).
                            새 눈 검수: 검수자와 기준 판정으로 대신할 단계 고르기(reviewPlan), 검수 프롬프트, oc-review 판정 블록 읽기, 판정 적기, 되돌림 블록(결정 0015)
                            회의 결론 다섯 칸 읽어 적기(meetingRecord·recordMeeting), 계획 뒤 남은 호출 어림(planEstimate), 꼬리의 "바꾼 파일" 칸 읽기(tailClaims: 경로와 판단할 수 있는지), 사용자가 고른 것을 적는 진행 기록 줄(userLine)(결정 0025)
server/report.js            완주 보고: 끝난 목표의 사실 묶기(buildReport), 기억에 넣는 글 판(reportText), 내 PC 모델만 받은 목표인지(reportLocal)(결정 0025)
server/proof.js             만들기·글 카드의 바꾼 파일 대조: git 상태 한 장(gitState)·두 커밋 사이 파일(gitDiffNames)·상태 차이(changedSet)·카드 하나 판단(proofCheck)(결정 0025)
server/teamdoc.js           문서로 팀 짜기(결정 0024): 글 문서 붙인 "팀 짜 줘" 알아보기(낱말 규칙), 쓰는 사람 고르기, 문서 읽기, 초안 프롬프트, oc-team 블록 읽기·정리(cleanTeamDraft), 팀 제안 카드 처리(만들기·그만·그냥 보내기)
server/usage.js             토큰·비용 집계, 계정 한도
server/savings.js           절약 프로필(설정 savings 'lean', 결정 0026): 앞 대화 절반(leanTurns), 앞 단계 결과 끝부분(prevTail), 조사 노트 파일(writeNote: 일 단계용 work/·회의용 meeting/ 하위 폴더)과 요약(noteSummary), 목표가 끝나면 노트 폴더 지우기(dropNotes), 줄였다는 알림 두 줄(prevNote·noteNote)
server/catalog.js           스킬·커넥터·플러그인 목록
server/routing.js           자동 라우팅(역할×프로필 → 프로바이더·모델·노력)
server/failover.js          자동 이어받기(한도 오류 판별, 쉬는 시간, 대체 AI 고르기, 이어받기 지시)
server/importer.js          Claude Code·Codex 기록(jsonl) 목록·읽기(원본은 읽기만)
server/storage.js           저장공간 보고·정리
server/providers/index.js   프로바이더 레지스트리(각 어댑터의 detect: 설치·로그인 탐지, models: 모델 목록)
server/providers/*.js       어댑터: claude, codex, gemini, hermes, openai(호환 API), local(내 PC 모델), acp(ACP 표준 에이전트), mock(가상 AI, 테스트용. 화면에 주는 프로바이더 목록에는 없다, 결정 0021)
server/providers/util.js    셸 없이 CLI 실행(.cmd 래퍼 해석), 줄 단위 읽기, 프로세스 트리 종료
server/providers/feeder.js  stdin 스트림 JSON 다중 턴(작업 중 지시 주입)
public/index.html           앱 셸(import map)
public/js/*.js              UI(Preact+htm)
public/js/mission-numbers.js 목표 카드의 숫자: 호출 어림 더하기(sumEstimate, 서버 estimateCalls 도 이 함수를 부른다), 받은 한도 기록에서 보일 창 고르기(limitRows), 기록 나이 단위(recordAge)(결정 0019)
public/js/stage-model.js    흐름 무대의 모델(DOM 없음): 마지막 실행·실시간 상태·목표·질문·팀 → 역·사람·내 차례·문 자리·끝 깃발. 회의 차례 이름(meetLabel)·목표 대기 표시(goalWait)·끝 깃발 이름(goalEndWord, 완주 보고 카드도 쓴다)도 여기(결정 0020)
public/js/report-lines.js   완주 보고의 글줄(확인 못 한 것·실패 종류·걸린 시간·종류 이름). 화면과 서버가 번역 함수만 바꿔 같이 쓴다(결정 0025)
public/js/usage-numbers.js  사용량 숫자(결정 0026): 환산(weighted = 새 입력 + 캐시 쓰기 + 출력 + 캐시 읽기÷10, 서버의 meetingSpend 도 이 함수), 나눠 보기(split), 캐시 적중률(cacheHit), 답의 종류(answerKind: 완주 보고 server/report.js 도 같은 함수로 센다. 보통 실행·목표 잡기·조사·회의·계획·일 단계·일 카드·검수·팀 초안·인수인계 메모)와 종류별·에이전트별 묶기(usageBreakdown, "이 목표 것만"은 답의 missionId 로), 구독 한도 상한을 넘은 창(overCap, 초기화 시각을 모르는 창은 받은 뒤 30분까지 UNTIMED_MS). 화면의 한 숫자는 환산(오른쪽 아래 표시·사용량 화면·세션의 사용량·한도 탭·메시지 아래·진행 바·팀 현황 카드, 나눈 값과 1:1 합은 도움말), 사무실 이름표의 토큰 숫자만 1:1 합 그대로
public/js/views/stage.js    흐름 무대(나눠 보기의 위쪽 그림, FlowStage)와 접은 한 줄 띠(StageStrip)(결정 0020)
public/js/views/teamdoc.js  팀 제안 카드(TeamCard, 결정 0024)
public/js/office/*.js       사무실 렌더러(독립 모듈)
public/css/*.css
test/*.test.js              node:test
test/measure/*.js           프롬프트 크기 실측(테스트 목록 밖, 손으로 돌린다. 가짜 CLI 만. 결정 0023)
```

## 데이터 모델
```
Agent    { id, name, role, emoji, provider, model, effort, systemPrompt,
           permission: 'plan'|'default'|'edit'|'auto'|'full',
           skills:[skillId], connectors:[connectorId], light:boolean,
           apiProfile?: string, avatar:{ skin, hair, hairStyle, outfit, accessory } , createdAt,
           tier?: 1|2|3|4(같은 AI 안의 사다리 등급. 1 가장 싸고 단순, 4 가장 비싸고 어려움. 문서로 만든 에이전트만, 결정 0024) }
Team     { id, name, description, stages:[ { id, label, agentIds:[...], instruction, approve:boolean, meeting:null|{ rounds, chairId, tokenCap, opposeId:null|agentId(반대편. null 이면 실행 때 자동으로 고른다, 결정 0010) } } ],
           ladder?: true, escalateAfter?: 2(문서로 만든 팀. 몇 번 실패하면 윗등급에게 넘길지 묻는가. 묻기는 아직 없다, 결정 0024) }
Session  { id, title, titleFrom?(제목을 만든 사용자 말 id), titleLocal?(그 말이 내 PC 모델만 받은 말이면 true: 기억 출처 줄에 제목을 싣지 않는다), teamId|null, agentId|null, cwd, createdAt, updatedAt,
           providerSessions:{ [agentId]: string }, sessionProvider:{ [agentId]: providerId },
           usageBase?:{ [agentId]: { id, input, output, cacheRead, cacheWrite, cost } }(Claude 사용량의 직전 누적. id 는 다음 호출이 이어 갈 CLI 대화 id 이고, 그 대화를 그대로 이어 갈 때만 뺀다. 믿을 수 없게 되면 지운다. 결정 0012),
           noteHashes?:{ [agentId]: string }(이어 갈 수 있는 AI 의 대화가 마지막으로 끝까지 받은 역할 노트 전체의 해시: 하는 일과 받을 수 있는 확정 항목(`notesKey`, 요청마다 달라지는 고른 묶음이 아니다). 없으면 노트를 받은 적 없는 걸로 본다. 이어 가는 실행에서 다르면 바뀐 노트 블록만 다시 붙인다(Codex·Claude 모두). 결정 0013·0023),
           convSent?:{ [agentId]: { id, head:['rules'|'ask'], calls, items:[itemId] } }(그 에이전트의 이어 갈 대화(id)가 받은 앞머리 구성(규칙 파일 줄·묻기 안내), 그 줄을 붙인 뒤 이어 간 호출 수, 받은 역할 노트 항목 id. id 가 지금 이어 갈 대화와 다르면 모른다고 본다. 결정 0023),
           importedFrom?:{ source:'claude'|'codex', id, cwd, total, at, agentId?(불러올 때 만든 에이전트), remembered?(불러온 대화를 프로젝트 기억에 다 넣었음), cleared?(대화를 비웠음: 불러온 대화를 더는 건네지 않는다), checked?(원문이 없어 원래 기록을 다시 읽어 봤음) }, messages:[Message], runs:[Run],
           goalMode?:boolean(목표 모드, 결정 0014), mission?:Mission }
Mission  (세션에 하나. 새 목표가 끝난 목표를 덮어쓴다. 결정 0014·0015·0016·0017·0018·0019)
         { version:1, id, status:'drafting'|'draft'|'active'|'waiting'(판정 뒤 묻기·호출 상한·한도 대기)|'done'(기준 전부 통과)|'accepted'(사용자가 받아들임)|'stopped'|'cancelled'|'cut'|'unreviewed'(2a-1 의 옛 끝 상태),
           phase:'goal'|'scan'|'questions'|'research'|'meeting'|'plan'|'work'|'review', request(앞 2,000자), requestMsgId, leadId, goal(200자), criteria:[{ id:'c1', text(300자), status:'open'|'pass'|'fail'|'unknown', evidence(검수자가 씀, 500자), check?(확인 방법 200자, 결정 0014 개정) }](7개까지), mustKeep:[…](바뀌면 안 되는 것 5개·200자),
           reviewerId|null(검수자. 확인할 때 정한다), dropped:[단계 이름](기준 판정으로 대신해 건너뛴 검수 단계), round(검수 횟수), returns(되돌린 횟수), returnCap(되돌림 상한, 처음 1),
           calls:{ used, cap }(CLI 호출 수와 상한. 목표 차례부터 센다. 상한 기본 40), extras:[…](마지막 검수의 남은 일, 막지 않음), keepBroken:[…](마지막 검수가 본 지킬 것 어김, 묻는다), repeatFail:[기준 id](두 회차 연속 불합격. 다음 되돌림에 가정 적기. 결정 0015 개정),
           keep:[팀 단계 번호](확인 때 "남기기"를 고른 검수 단계. 이어서 할 때 같은 단계표를 다시 만든다), cwd(확정 때의 작업 폴더), roles:{ [에이전트 id]: roleKind }(확정 때 팀원의 역할 종류. 이어서 할 때 대조. 결정 0016),
           prep:{ research, meeting, direct }(확인 때 고른 일하기 전 대목. 진행자가 바로 실행을 권했는지. 결정 0017), research:null|{ scanMsgId, questions:[{ id:'q1', text(200자), agentId, status:'pending'|'running'|'done'|'empty'|'failed'|'skipped', msgId, outside? }](6개까지), noteMsgId(조사 노트 카드), fallback?(질문 블록을 못 읽어 질문 하나로) }, meetingMsgId|null(일하기 전 회의의 결론 답),
           at:{ stageIndex, phase:'scan'|'questions'|'research'|'meeting'|'plan'|'work'|'review', back(되돌림 중), working:[에이전트 id](CLI 를 띄운 채 일하는 사람. 띄울 때 넣고 앱이 끄지 않은 채 끝나면 뺀다. 회의의 조사 담당·검수자도), finished:[메시지 id](이 단계에서 끝낸 답, 회의는 결론), wait:null|{ reason:'approve' }|{ reason:'error', failed:[{ agentId, error }] }|{ reason:'mission', kind:'verdict'|'notes' }|{ reason:'cap', quota?:true(한도 대기 뒤 다시 하기 앞, 결정 0019) }|{ reason:'quota', until(아는 초기화 시각 ms. 지났어도 그대로, 모르면 0), failed:[{ agentId, error, provider(한도에 걸린 AI) }] }(한도 대기, 결정 0019)|{ reason:'limitcap' }(구독 한도 상한: 일을 시작하기 전의 질문. 이어서 하면 그 자리의 검사가 호출 없이 다시 묻는다, 결정 0026) }(끊긴 자리. 단계 시작·끝, 되돌림 결정, 다시 하기·거절, 대기 시작, 사람마다의 시작·끝에 고치고 바로 저장. 결정 0016),
           work:'cards'|'stages'(일하는 방식, 결정 0018), cards:null|[{ id:'k1', title(120자), ownerId, kind:'research'|'write'|'build'|'check', needs:[앞 카드 id], done(200자), files:[…](8개·200자), not(200자), status:'waiting'|'running'|'done'|'blocked'|'skipped'|'hole', by?:'blocked'|'quota'(구멍의 사유: 막힘 받아들이기·한도 대기 건너뛰기, 결정 0019), starts, cap(처음 3), msgId, tailMsgId?, tail?, reason?, proof?:{ files, at }(바꿨다고 적은 파일이 git 으로 보면 안 바뀜. 경고만, 결정 0025) }](6장까지), rate:{ cap(처음 20), starts:[시각](한 시간 안에 시작한 카드) }, planMsgId(계획 카드),
           outOfScope:[…](5개·200자), userDecides:[…](5개·200자), notes:[{ id, text, at, used, msgId, files?:[{name,path}] }](도는 중에 온 추가 지시. 50개까지),
           estimate?:{ min, max, returns, cap, spent }(확인 시점의 호출 어림. 목표 잡기에 쓴 호출 포함. 옛 목표엔 없다), quota?:{ autos }(한도 대기와 구독 한도 상한에서 자동 이어서를 쓴 횟수, 둘이 같이 3번까지. 결정 0019·0026), capOk?:[프로바이더](구독 한도 상한에서 "계속"을 고른 AI 와 한도 대기에서 그만 말고 다른 걸 고른 AI: 이 목표에서 상한으로 다시 묻지 않는다. 결정 0026),
           meetings?:[{ prep:true | stageIndex, msgId, decision(300자), reasons:[…], dissent:[…], dropped:[…], next:[…](5개·300자) }](목표 회의의 결론에서 읽은 다섯 칸. 못 읽은 칸은 빈 값. 20개까지. 결정 0025), reportMsgId?(완주 보고 카드. 두 번 만들지 않는다),
           cardMsgId, confirmedAt, editedByUser, cutNotice?('drafting'|'cut': 다시 켤 때 대화에 한 줄 남기고 지운다), log:[{ at, kind(… 'quota' 한도 대기, 'block' 대목이 받지 않는 블록, 'route' 요청한 AI와 다르게 돎, 'error' 오류 대기 앞의 실패, 'proof' 바꾼 파일 대조 경고, 결정 0025), text, msgId?, n?, by?:'user'(사용자가 고른 것을 적은 줄, 결정 0025), fail?:'review'|'outside'|'blocked'|'hole'|'keep'|'input'(기다린 앞 카드에 결과가 없었음)|'unknown'(보통 오류, 원인 모름), agentKind?:'unclear'|'input'|'capability'|'dependency'|'unknown'(막힘 줄: 에이전트가 oc-blocked 에 적은 종류, 결정 0022) }](200줄, 넘으면 맨 앞에 "앞 n줄 생략" 한 줄 kind 'skip'·n), createdAt }
         살아 있는 목표 = drafting·draft·active·waiting·cut: 새 목표를 못 만들고, 목표 모드 끄기·팀 바꾸기는 409
Message  { id, role:'user'|'agent'|'system'|'proposal'(kind 'hire': 영입 제안 카드, 결정 0006 / kind 'team': 팀 제안 카드 { status:'open'|'done'|'dismissed'|'sent', userMessageId, writerId, draftMsgId, rev(판. 다시 정리할 때 +1), draft:{ name, agents:[{ name, role, provider, model, modelLabel, effort, routing, routingProfile, tier, said(문서의 표현), when, warn:['provider'|'model'|'effort'|'suspect'], suggest?:'edit' }], stages:[{ label, agents:[이름] }] }, notes, docs:[파일 이름], cut?, renamed?:[{ kind:'team'|'stage', n?, text }](주입 무늬라 중립 이름으로 바꾼 팀·단계 이름의 원래 표현), teamId?, agentIds?, switched?, goalModeOff? }(코드가 정리한 초안. 결정 0024) / kind 'goal': 목표 카드 { missionId, leadId, draftMsgId(카드를 읽은 진행자 답. 요청 글로 만든 카드면 null), goal, criteria, outOfScope, userDecides, review?:{ reviewerId, reviewerName, droppable:[{ index(팀 단계 번호), label, names, instruction(앞 120자) }] }(검수 줄, 결정 0015), prep?:{ direct, research:{ can, on, who:[{id,name}], min, max }, meeting:{ can, on, who, rounds, calls, checks } }(조사·회의 먼저 줄, 결정 0017), warn?, fallback?, status:'open'|'confirmed'|'cancelled', createdAt, confirmed?, edited?, prepChosen?:{ research, meeting }, checks?, keep?, reviewerReadOnly?, work?:{ can, why:''|'approve'|'meeting'|'few', on }, workChosen?, estimate?(호출 어림 조각 estimateParts: spent, cap, research, meeting, review, returns, cards, stages. 화면이 고른 값으로 더한다), providers?(구독 한도 줄에 보일, 팀원이 직접 정한 AI. 결정 0019), resolvedAt? }, 결정 0014 / kind 'plan': 계획 카드 { missionId, leadId, draftMsgId, cards:[{ id, title, ownerId, owner, kind, needs, done, files, not, solo }], waves:[[카드 id]], wavesText, fallback?, reassigned?:[{ id, from, to }], estimate?:{ min, max, returns, used, cap }(계획 뒤 남은 호출 어림, 결정 0025) }(코드가 다듬은 일 카드. 넘기는 대화·기억에 싣지 않는다. 결정 0018) / kind 'report': 완주 보고 { missionId, end, goal, from, to, calls, estimate, answers, answerFails, criteria, user, userMore, unverified, fails, routes, logCut, meetings, files, filesState:'pending'|'none'|'done', memFolder(기억에 넣을 폴더: 목표가 돈 폴더), local?, memory?:{ added, on, at, key } }(목표가 끝나면 코드가 묶는다. AI 호출 없음. 넘기는 대화에 싣지 않고, 기억에는 사용자가 넣기를 누를 때만. 결정 0025) / kind 'research': 조사 노트 카드 { missionId, status:'done', total, missing, fallback?, questions:[{ id, text, agentId, status, msgId, excerpt(답 앞 1,200자), more }] }(코드가 묶는다. 넘기는 대화·기억에 싣지 않는다. 결정 0017)), agentId?, runId?, stageIndex?, text,
           mission?(사용자 말: 목표 차례로 돌 요청), missionNote?(사용자 말: 목표가 도는 동안 온 추가 지시. 넘기는 대화에서 빼고 [사용자 추가 지시]로만 간다. 기억에는 목표 실행이 끝날 때 넣고, local 은 받은 AI 로 정한다), goalDraft?(에이전트 답: 목표 카드 초안. 넘기는 대화·기억에 싣지 않고, 인수인계 메모 쓸 에이전트를 고를 때 답한 것으로 세지 않는다), missionId?(에이전트 답: 목표 실행(목표 잡기·일 실행)의 답이 어느 목표 것인지. 사용량의 종류(일 단계)와 "이 목표 것만"이 본다. 결정 0026), goalBlock?:{ from, to }(그 답에서 읽은 oc-goal 블록 자리. 화면이 감춘다), review?:{ round, results:[{ id, verdict, evidence, text(코드가 가진 기준 문장) }], missing(판정 블록을 못 받음), retried?, quota?(사용량 한도로 끊긴 판정 답. 화면은 회차 대신 "한도로 중단", 결정 0019) }(에이전트 답: 목표의 기준 판정. 기억에 넣지 않는다. 결정 0015), reviewBlock?:{ from, to }(받은 oc-review 블록 자리. 화면이 감추고 기준표로), once?(에이전트 답: 한 번 실행으로 돈 차례. 기준 판정·일하기 전 조사·목표 실행의 회의 차례·긴 세션의 보통 회의 차례. 그 에이전트의 CLI 대화에 없어서 놓친 대화·인수인계 메모 자격을 셀 때 답한 것으로 세지 않는다. 목표 실행의 회의 차례(`meeting` 도 있음)는 넘기는 대화에 싣지 않는다), freshMeet?(에이전트 답: 긴 세션의 보통 회의 차례가 한 번 실행으로 돌았음. once·meeting 이 있어도 넘기는 대화에 보통 답처럼 싣는다. 결정 0023), prep?:{ kind:'scan'|'questions'|'research'|'meeting'|'plan', qid?, questions?, retried? }(에이전트 답: 일하기 전 조사·회의. 기억에도 넘기는 대화에도 싣지 않는다. 결정 0017), researchBlock?:{ from, to }(받은 oc-research 블록 자리. 화면이 감추고 질문 목록으로), planBlock?:{ from, to }(받은 oc-cards 블록 자리), card?:{ missionId, id }(일 카드의 답. 그 목표가 살아 있는 동안 넘기는 대화에 싣지 않는다), cardTail?(끝의 두 칸을 다시 쓴 답), blockedBlock?:{ from, to, reason }(일 단계 답 끝의 oc-blocked. 화면이 감추고 "막힘: 이유"로. 결정 0018), handoffAsk?(사용자 말: 인수인계 메모를 써 달라는 정해진 요청. 대화·기억에 싣지 않는다), teamDoc?(사용자 말: 문서로 팀을 짜 달라는 말. 넘기는 대화·기억에 싣지 않고, "그냥 보내기"면 지운다. 결정 0024), teamBlock?:{ from, to }(팀 초안 답에서 읽은 oc-team 블록 자리. 그 답은 prep:{ kind:'team' }·once), handoff?(에이전트 답: 인수인계 메모. 이어받는 다른 AI가 먼저 받는다. 결정 0008), local?(사용자 말: 보낼 때 계획의 AI가 모두 내 PC 모델이면 true, 클라우드 AI가 실제로 받으면 지운다. true 면 클라우드 AI로 넘기는 대화·기억에서 뺀다. 결정 0007), remembered?(사용자 말: 프로젝트 기억에 넣기 시작했음. 두 번 넣지 않는다), cut?(대기열에 있다가 앱이 꺼진 말. 다시 켤 때 기억에 넣고 지운다),
           meeting?:{ phase:'opinion'|'turn'|'research'|'judge'|'conclude'(옛 메시지는 'review'), round, rounds, opposer?:true }(회의 차례), verdict?:{ verdict:'agree'|'continue', reason }(진행자 판정에서 읽은 블록. 결정 0010),
           check?:{ question, from, to, status:'asked'|'answered'|'no-researcher'|'over'|'low'(목표의 남은 호출이 적어 조사를 끔, 결정 0017)|'near'(조사 담당 AI의 구독 한도가 임박이라 조사를 끔, 결정 0022)|'failed' }(차례 답 끝에서 읽은 조사 질문 블록. 블록은 글에 남고 from·to 자리를 화면이 감춘다), checkOf?(조사 결과: 질문한 차례 메시지 id. 결정 0011),
           route?:{ asked:{ provider(자동 라우팅이면 'auto'), model, effort }, ran:{ provider, model, effort }, why:['auto'|'near-limit'|'daily-budget'|'daily-pace'|'takeover'|'wait-reset'|'account-gone'] }(배정 기록: 에이전트 설정이 요청한 AI(지운 Codex 계정이면 그 계정 그대로), 실제로 돈 AI, 코드가 한 일의 이유 코드. 이어받으면 고친다. 돌지 못한 답에는 없다. 결정 0022),
           attachments:[{id,name,mime,size,path}], blocks:[Block], status:'streaming'|'done'|'error'|'stopped',
           usage?:{input,output,cacheRead,cacheWrite,cost,durationMs, partial?(true: 하위 에이전트 몫이 빠졌을 수 있다), sub?(주 에이전트 밖에서 쓴 토큰: 하위 에이전트 등, 네 값 1:1 합. 결정 0012), subW?(같은 몫의 환산. 화면 도움말이 옆 숫자와 같은 단위로 쓴다. 결정 0026)}, createdAt }
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
           stageIndex, hold?:{ reason:'pause'|'approve'|'error'|'mission'|'cap'|'quota'|'limitcap', stageIndex, at, …(mission: kind 'verdict'|'notes'|'blocked'|'limit', round, left, notes, more?, reviewer?, extras?, keepBroken?, blocked?, cards? / cap: kind?'rate'|'plan'(plan: 계획 뒤 어림이 남은 호출보다 많음, min·max 도. 결정 0025), used, cap, step / quota: phase 'work'|'review', until, passed?(이어서 할 때 저장된 시각이 이미 지남), canAuto, autos, autoMax, out:'skip'|'accept'(예전 출구), who:[{ agentId, name, provider, ai, error(AI가 보낸 오류 문구 300자, 화면에만) }], autoAt?(자동 이어서를 고른 뒤 다시 시작할 시각). 결정 0019 / limitcap: phase, cap, until(넘은 창이 모두 풀리는 시각, 모르면 0), canAuto, autos, autoMax, autoAt?, ran?(이미 돈 단계에서 물음), who:[{ agentId, name, provider, ai, windows:[{ key, pct, resetsAt }] }](결정 0026) }, stages:[{ label, agentIds, status, mission?:'review'(목표의 기준 판정 단계)|'scan'|'questions'|'research'|'meeting'(일하기 전 대목, 단계표 맨 앞. 결정 0017)|'plan'|'cards'(일 카드의 계획 대목과 카드 단계. 결정 0018), cardIds?(그 단계의 카드), count?(조사 질문 수, 단계 띠의 ×n), note?, meetingNow?:null|{ phase, round, rounds, speakerId?(차례·조사 중인 사람), opposerId?(반대편이 있으면 늘), askedBy?(조사 중일 때 질문한 사람) }(회의 진행 표시. 결정 0010·0011) }], startedAt, endedAt }
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
- 프롬프트 조립(결정 0023, `#system`): 시스템 지시는 에이전트마다 고정한다. 이름·역할·지시·작업 폴더·저장된 권한의 문장·검수 규칙·마지막 답·언어 줄, 역할 노트의 하는 일·사용자가 정한 항목·"더 있어" 줄, 스킬 본문. 새 대화 한 번으로 도는 회의의 의견·차례·판정·결론 차례(목표 회의, 긴 세션의 보통 회의)는 스킬 본문만 뺀 것으로 따로 고정한다(회의 중 조사와, 자기 세션 대화를 열거나 이어 가는 짧은 세션의 회의 차례는 스킬 그대로: 그 대화를 나중에 일 차례가 이어 가는데 Claude 는 첫 요청의 지시를, Codex 는 처음 감싼 지시를 계속 쓴다). 호출마다 달라지는 것(`head`: 그 실행만 읽기 전용인 차례의 권한 문장("저장된 권한보다 이 줄이 우선"), 읽기 전용 에이전트의 규칙 파일 읽기 줄(새 대화로 도는 회의 말 차례에는 없음), 묻기 안내, 역할 노트의 참고 블록)은 `#runAgent` 의 `start` 가 새 대화의 첫 프롬프트 맨 앞에 붙인다(빈 줄 하나로 본문과 가름). 읽기 전용을 글로만 묶는 AI(`caps.permissions` 가 false)의 그 실행만 읽기 전용인 차례는 권한 문장을 head 가 아니라 시스템 지시의 권한 자리에 둔다(저장된 권한의 문장과 같이 주지 않는다). 이어 가는 대화에는 `convSent`·`noteHashes` 와 견줘 모자란 것만 같은 자리에 붙인다: 이번 차례에 필요한데 그 대화가 못 받은 규칙 파일 줄·묻기 안내(`HEAD_AGAIN` = 10번째 이어 가는 호출마다 한 번 더), 노트가 바뀌었으면 바뀐 노트 블록만(`#notesFor`: "역할 노트가 바뀌었어" 줄 + `<역할 노트>` 안에 하는 일·사용자 항목·"더 있어" 줄·참고 블록, 다 비었으면 "이제 쓰지 마" 줄. 이름 줄·스킬 같은 지시 전체는 다시 안 보낸다), 그대로인데 이번에 고른 항목 중 그 대화가 못 받은 것이 있으면 그 항목만("더 줄게" 줄). 한 번 실행이 같은 차례 안에서 이어 가는 대화(긴 세션 회의 차례의 추가 지시)에는 붙이지 않는다. 이어 간 Claude 대화는 첫 요청의 시스템 지시를 압축 전까지 그대로 쓰고, 같은 시스템 지시끼리 캐시를 나눠 쓴다. 압축을 알아채는 코드는 없다.
- 보통 회의(목표 밖, 결정 0005·0010·0011·0023): 자기 CLI 대화를 이어 가는 참석자(`ctx.meetSeen`: 그 대화가 이미 받은 "지금까지 나온 말"의 수)의 차례·판정·결론에는 그 뒤에 나온 남의 말만 바퀴 표시와 함께 준다(`#meetingPrompt` 의 `heard`. 자기 말은 대화에 있다. 새 말이 없으면 표식 설명 줄도 뺀다). 새 대화(처음 차례·이어받기·이어하기 실패, 이어 가지 못하는 AI)면 전부 주되, 자기 말은 목표 회의처럼 "[네가 앞에서 한 말]"로 따로 둔다. 긴 세션(`#longTalk`: 넘길 수 있는 앞 대화 `#talkList` 가 `historyTurns` × 2 보다 많음. `historyTurns` 가 0 이면 판정에는 기본값 8)이면 회의를 시작할 때 `ctx.meetFresh` 를 켜고 모든 차례(회의 중 조사 포함)를 목표 회의처럼 한 번 실행(`once.fresh`, `msg.freshMeet`)으로 돌린다: 대화 번호를 읽지도 남기지도 않고, 프롬프트는 이번 요청 전문 + [이전 단계 결과] + 회의에서 나온 말 + 앞 대화에서 고른 부분(`#meetPicks`: 먼저 최근 대화 4개(한 건 1,000자), 남은 예산으로 `pickEarlier`(맨 처음 두 개와 요청과 낱말이 겹치는 것, 한 건 600자), `MEET_PICKS` 합 5,000자, 받는 쪽마다 실행에 한 번. `historyTurns` 가 0 이면 없음). [이전 대화]·대화 전체 파일·인수인계 메모·프로젝트 기억·놓친 대화는 없다. 추가 지시는 지금처럼 받고(`drainSteer` 도 그 차례 대화에), 그 차례에 넣은 지시는 `ctx.meetSteer` 에 사람마다 모아 그 사람의 뒤 차례 프롬프트에 [사용자 추가 지시]로 넣는다. 그 차례 안에서 대화를 이어 간 호출의 Claude 사용량은 그 차례의 직전 누적(`call.bases`)을 빼서 센다. 그 답은 넘기는 대화에 보통 답처럼 싣는다(`notTalk` 가 `freshMeet` 은 빼지 않는다). 다음 단계에는 지금처럼 결론만 [이전 단계 결과]로.
- 절약 프로필(결정 0026, 설정 `savings`: `normal` 기본 = 지금대로 / `lean`): ① 최근 대화는 `historyTurns` 의 절반(올림, 최소 1. 0 은 0): 처음 맡는 에이전트의 [이전 대화](`#withHistory`)와 기억 못 하는 모델에 매번 주는 최근 대화(`#historyList`: Gemini·ACP·Hermes·내 PC 모델의 [이전 대화] 글, API 에이전트의 대화 배열). 잘라서 앞머리에 에이전트 답이 남으면 빼서 사용자 말부터(요청과 답의 짝을 깨지 않게). 놓친 대화·긴 세션 판정은 그대로 ② 목표의 조사 노트(`#notePart`)는 파일 도구가 있는 AI(`caps.tools`)에게 파일(`handoff/<세션>/research/<목표>/work/note-work.md`(지시처럼 보이는 줄을 뺀 판)·`.../meeting/note-meeting.md`, 답을 자르지 않은 노트. 표식은 목표마다 고정이라 같은 글이면 다시 쓰지 않는다)과 요약(노트 머리 줄 + 알림 한 줄 + 경로 + 질문마다 답의 첫 줄 160자, 본문 2,000자까지)만, 그 차례에 맞는 판의 폴더만 그 실행에 연다(`talkOut` 의 `addDirs`·`extraDirs`, 결정 0008 과 같은 길. 일 단계가 회의용 판을 경로로 읽지 못하게). 끝난 답에는 성공한 도구 호출이 그 파일을 가리켰는지 한 줄(결정 0008 과 같은 방식, 중간 출력이 없는 CLI 는 생략). 파일 도구가 없거나 파일을 못 쓰거나 이어 가는 Codex 대화(Codex 는 새 대화에서만 폴더를 연다)면 지금처럼 전문. 계획 대목(`#planStage`)의 노트는 그대로. 노트 폴더는 목표가 끝나면(통과·받아들임·중지)·끊긴 목표를 버리면 지운다(`dropNotes`. 완주 보고·이어서는 이 파일을 쓰지 않고, 이어서는 메시지로 다시 쓴다. 끊긴 목표는 그대로) ③ [이전 단계 결과]는 결과가 있는 마지막 앞 단계만 전문, 그보다 앞 단계는 끝 1,500자(`prevTail`, 앞에 "…(앞부분 생략)")와 머리에 알림 한 줄(실제로 줄였을 때만). 기준 판정 자료(`reviewPrompt`)·되돌림의 직전 결과·일 카드의 앞 카드 결과는 줄이지 않는다.
- 에이전트마다 CLI 세션 ID를 세션에 저장 → 다음 턴은 resume으로 이어감(기억 유지).
- `@이름` 멘션 → 그 에이전트에게만 보냄. 팀 없는 세션 → 단일 에이전트 채팅.
- 개입: steer(지시 추가: Claude는 실행 중 stdin 주입, 나머지는 턴 종료 후 이어서 실행. 목표의 기준 판정 중인 검수자와, 일하기 전 조사·회의나 목표 실행의 회의 차례(한 번 실행)에 있는 에이전트에게는 넣지 않고 목표의 추가 지시로 받는다), pause(현재 단계 끝나면 멈춤), resume, stop(프로세스 트리 종료), skip(현재 에이전트 중단 후 다음), retry(단계 재실행), approve/reject(승인 게이트, 거절 시 피드백 붙여 재실행). conclude(회의 단계에서 남은 바퀴를 건너뛰고 진행자가 바로 결론).

### 목표 모드(`server/mission.js`, 결정 0014)
- 켜기: 세션 PATCH `goalMode`. 팀 없는 세션, 내 PC 모델과 클라우드 AI(자동 라우팅은 어느 쪽으로도 셈)가 섞인 팀, 예약 실행·칸반 카드 세션은 400 과 이유(`missionProblem`). 요청이 목표가 될 때·확인할 때 다시 본다.
- `send`: @이름·인수인계·예약이 아닌 말은 지금 끼어들기·영입 감지보다 먼저 본다. 살아 있는 목표 없음 → 목표 차례 / 카드 대기 → 그 카드를 닫고 목표 차례 / 도는 중 → 추가 지시(`notes`) / 끊김 → 400. 초안을 쓰는 중에 온 말은 모드(지금 끼어들기·다음 차례로)와 상관없이 진행자에게(steer). 다른 실행이 돌면 대기열(`mission: true`). 영입 카드의 "그대로 보내기"(`sendProposed`)도 같다(살아 있는 목표가 있으면 409).
- 추가 지시(`#missionNote`): 그 뒤에 시작하는 단계들과, 승인·오류 대기 중에 왔으면 거절·다시 하기로 다시 도는 그 단계에 들어간다. 50개까지(넘으면 400). 검수자에게는 주지 않는다. 판정 뒤에 안 쓴 지시가 있으면 묻는다(결정 0015). 일 실행이 없을 때만 응답에 `late: true`. 기억에는 목표 실행이 끝날 때(앱을 끌 때·끊긴 목표를 다시 켤 때도) 넣는다: 받은 AI 가 모두 내 PC 모델이면 local, 클라우드 AI 가 하나라도 받으면 표시 없이, 아무도 안 받았으면 보낼 때의 팀 구성대로(`#received`·`#rememberNotes`).
- 목표 차례(`#goalTurn`): 진행자(첫 회의 단계 진행자 → analysis 역할 첫 팀원 → 첫 단계 첫 에이전트) 혼자인 단계 하나. 답 맨 끝의 ```oc-goal 블록을 읽고(`parseGoal`·`cleanGoal`), 못 읽으면 같은 실행에서 한 번 다시 요청, 그래도 안 되면 요청 앞 200자를 목표로 한 기준 없는 카드. 오류·중지·진행자 건너뛰기면 목표를 닫는다(오류·건너뛰기는 대화에 한 줄). 진행자의 `providerSessions`·`sessionProvider`·`usageBase`·`noteHashes`·`convSent` 는 시작 때 적어 두고 끝날 때 되돌린다(일 단계가 목표 차례의 CLI 대화를 이어 가지 않게).
- 확인(`confirmMission`): 화면이 보던 카드 전체(`expected`)를 저장된 초안과 글자까지 대조(`sameCard`), 검수 줄(`review: { reviewerId, droppable, drop }`, droppable 은 카드가 보여 준 번호·이름·담당·지시 목록)을 지금 팀으로 다시 계산한 값과 글자까지 대조(다르면 409 + `review`, 없으면 아무것도 안 뺀다). 확정하면 실행 하나(`#missionPlan`: 사용자가 남기지 않은 검수 단계를 빼고, 검수자가 있으면 맨 끝에 기준 판정 단계). 실행을 먼저 넣고 저장한다(도는 목표가 도는 실행 없이 저장되지 않게). 각 단계 지시의 맨 앞에 "확정된 목표와 합격 기준" 블록(`#goalCardPrompt`, < > 는 전각). 그 앞에는 지금처럼 프로젝트 기억·인수인계 메모·놓친 대화, 이어 갈 대화가 없는 에이전트면 `[이전 대화]`가 붙는다. 일 단계는 `#missionRun`·`#missionWork` 가 돌린다(단계 본문은 목표 모드가 아닌 실행과 같은 `#runStage`).
- 새 눈 검수(`#reviewStage`, 결정 0015): 검수자(`reviewPlan`: 팀의 검수 단계 에이전트 중 진행자가 아닌 첫 사람 → 진행자도 마지막 일 단계 담당도 아닌 첫 팀원 → 없음. 팀 밖에서 고르지 않는다)를 한 번 실행(`#runAgent` 의 `once`)으로 돌린다: 대화 번호·사용량 직전 누적·역할 노트 해시를 읽지도 쓰지도 않고, 프롬프트는 `reviewPrompt` 만(앞 대화·기억 없음), 질문 창·밀린 지시 없음, 기억에 안 넣는다. 답 맨 끝의 ```oc-review 블록을 일회용 값과 기준 id 로 읽고(`parseReview`), 못 읽으면 새 값으로 한 번 다시, 그래도 안 되면 판정 없음(전부 unknown). 결정 0015 개정(2026-11-22): 기준마다 확인 방법·바뀌면 안 되는 것을 프롬프트에, 기준에 걸리면 사소해도 fail·근거 없는 fail 은 unknown·기준 밖은 `extras`(막지 않음)·지킬 것 어김은 `keepBroken`(묻는다), 작업 폴더가 git 이면 `git status --porcelain` 50줄을 표식 안에(테스트 파일이 바뀌면 진행 기록), 형식을 두 번 놓친 판정은 구멍(`fail: 'hole'`), 두 번째 되돌림·같은 기준 연속 불합격이면 되돌림 프롬프트에 "[가정 적기]".
- 판정 뒤(`#missionRun`): 중지 → stopped / 안 쓴 추가 지시 → 묻기(`hold.reason: 'mission'`, kind notes) / 전부 통과 → done / 불합격이 있고 되돌림이 남음 → 마지막 일 단계를 걸린 기준 블록(`returnPrompt`, 무작위 표식)과 함께 다시(그 단계의 직전 결과도 표식 안의 참고로. 이어 가는 대화에 이미 있으면 빼고. 회의면 진행자 혼자 결론을 받아, 승인 단계면 승인을 다시 묻는다. 그 뒤 단계는 다시 안 돌고 다음 검수 자료에서 옛 답을 뺀다) → 다시 검수 / 그 밖 → 묻기(kind verdict: 받아들이기 accepted · 한 번 더 · 그만). "한 번 더"는 되돌림 한 번(`returnCap = returns + 1`). 단계 앞마다 호출 상한(`#capCheck`, `hold.reason: 'cap'`, 20번 더 · 그만). 검수자가 없으면 판정 없이 묻는다("한 번 더" 없음, 그 대기 중 추가 지시는 late). 회의 단계는 회의 호출 수 식(`meetingCalls`)으로 상한을 검사한다(결정 0017). 단계 안의 다시 시도·이어받기와 회의 중 조사는 상한을 넘을 수 있다. 검수 답·목표 초안은 그 에이전트가 답한 것으로 세지 않는다(놓친 대화·`#historyList`·인수인계 메모 쓸 사람). 기준 판정 중(또는 그 차례의 한도 대기 중)인 에이전트를 골라 보낸 지시와, 일 실행 중 일하지 않는 에이전트에게 보낸 지시는 목표의 추가 지시가 된다.
- 진행 기록(`logLine`): 목표 초안·확인(검수자·건너뛴 단계)·단계 시작/다시/끝·추가 지시·검수 결과·되돌림·물은 것과 답·상한·끊김·이어서·버림·끝. 다시 켜면 `#fixStale` → `cutMission`(초안 쓰던 목표는 닫고, 도는 중·대기는 `cut`, 끊긴 자리 `at` 은 그대로). 저절로 다시 돌지 않는다.
- 이어서(`resumeMission`, 결정 0016): 사용자가 누를 때만. `cut` 이고 도는 실행이 없고 팀 검사(`missionProblem`, 아니면 400)를 지나고 요청 메시지·`at`·`keep`·끊긴 실행 기록이 있어야 한다. 확정 때의 작업 폴더(`cwd`)·역할 종류(`roles`)와, 지금 팀과 `keep` 으로 다시 만든 `#missionPlan` 이 끊긴 실행과 단계 수·기준 판정 자리·라벨·담당(순서)·승인·회의 여부·회의 설정(바퀴 수·진행자·반대편·사용량 상한)·단계 지시·검수자가 같아야 한다(`stageDiff`, 아니면 409 와 무엇이 다른지. 에이전트의 AI·권한은 대조하지 않는다). 새 일 실행(`resumed`) 하나를 끊긴 자리(`resumePoint`)부터 돈다(`#missionRun(ctx, from)`): 일 단계면 그 단계부터(`finished` 의 답은 그대로 쓰고 그 사람은 다시 안 돈다. 회의는 1바퀴부터), 되돌림이면 그 되돌림을 걸린 기준·직전 결과와 함께(되돌림 수는 다시 안 센다), 기준 판정이면 판정부터(같은 회차), 승인·오류 대기면 저장된 답(과 오류 줄)으로 호출 없이 같은 질문부터(`#runStage` 의 resume. 거절·다시 하기는 단계 전체), 판정 뒤 묻기·호출 상한이면 호출 없이 같은 질문. 앞 단계 결과는 이 목표의 일 실행들의 메시지에서 다시 모은다(`pastOutputs`: 단계·에이전트마다 가장 최근의 끝난 답, 회의는 결론 또는 되돌림에서 진행자 혼자 고친 답. 검수 답·목표 초안·인수인계 메모는 뺀다. 못 찾은 단계는 이름을 적고 건너뛴 단계는 세지 않는다). 끊긴 일 단계의 `working` 에이전트는 `providerSessions`·`sessionProvider`·`usageBase`·`noteHashes`·`convSent` 를 지우고 새 대화로, 그 단계에서 각자의 첫 호출 프롬프트 맨 앞에만 "[이어서] …" 한 줄(`ctx.resumeAt`). 회의 단계는 아무의 대화도 지우지 않고 "[이어서]" 도 안 붙인다(결정 0017부터 목표의 회의 차례는 늘 한 번 실행이라 1바퀴부터 다시 할 뿐). 기준 판정 중 끊긴 검수자는 건드리지 않는다(한 번 실행). 호출 수·되돌림 수·회차·판정·쓴 추가 지시(`liveNotes`)는 저장된 값에서 이어 간다. 실행 기록을 30개로 자를 때 살아 있는 목표의 일 실행은 남긴다. 앱을 정상으로 끌 때(`stopAll`)는 끄는 중 표시(`closing`)로 `#missionEnd` 가 목표 상태를 바꾸지 않는다(다시 켜면 `cut`). 세션을 디스크에서 읽을 때 멈춘 실행의 도는·승인 대기 단계는 `stopped` 로(`#fixStale`, 목표가 아닌 실행도).
- 일하기 전 조사와 회의(결정 0017): 목표 카드의 `prep`(`prepCard`: 조사 담당 = 팀의 research 역할 전원, 참석자 = 진행자 + build·review 가 아닌 팀원 최대 5명, 기본 켜짐, 진행자가 블록에 `"direct": true` 를 쓰면 기본 꺼짐, 못 하는 대목은 잠김, 진행자 `lead: { id, name, inTeam }` 가 팀에 없으면 두 대목 다 잠김, 어림값). 확인 본문의 `prep: { research, meeting, lead, researchers, attendees }` 를 지금 팀과 대조(`prepFits`, 진행자·명단이 다르면 409 + `prep`, 없으면 조사·회의 없이). 고른 대목은 `#missionPlan` 이 단계표 맨 앞에 붙인다(`mission: 'scan'|'questions'|'research'|'meeting'`). `#prepRun` 이 차례로: 훑어보기(`#scanStage`, 조사 담당 첫 사람) → 조사 질문(`#questionsStage`, 진행자의 ```oc-research 블록 `parseResearch`, 못 읽으면 한 번 다시, 그래도 안 되면 질문 하나) → 조사(`#researchStage`, 질문마다 한 번, 사람끼리 동시에·한 사람 것은 차례로, 실패·빈 답·건너뛰기는 그 갈래만 "확인 못 함". 프롬프트에 다른 갈래가 맡은 질문 목록(같은 표식 안)과 "- 사실 | 출처 | 확인함·확인 못 함" 줄 형식) → 조사 노트 카드(`#researchCard`) → 준비 회의(`#prepMeeting`, 지금 회의 엔진을 `#runStage` 로, 2바퀴). 조사는 질문을 시작하기 전마다 일시정지·중지를 본다(`#prepPause`, 조사 담당이 여럿이어도 대기 하나). 대상 없는 건너뛰기는 그때 도는 질문만 건너뛴다. 모든 차례는 한 번 실행(`#runAgent` 의 `once`, `msg.prep`·`msg.once`, 기억에 안 넣음). 훑어보기·조사 질문·조사와 목표 실행의 회의 차례(준비 회의·팀 회의 단계의 의견·차례·판정·결론·회의 중 조사)는 그 실행만 `permission: 'plan'`(+ `readOnlyRun: 'research'|'talk'`, 그 실행의 권한 문장을 AI의 `caps.permissions`·`caps.tools`에 맞춰 프롬프트 앞머리(`head`)에 넣고 규칙 파일 줄은 뺀다. 시스템 지시에는 저장된 권한의 문장(`savedPermission`), 결정 0023)으로 돈다. 이어받기 뒤에도 그대로. 기준 판정·일 단계와 저장된 에이전트는 그대로. 조사 노트(`answerFlags`)는 지시처럼 보이는 줄(`instructionLine`: `strip` 뒤 0013 의 `INJECTION` 무늬 중 시키는 꼴만)과 출처 없는 목록 줄(주소·`파일:줄`·`경로/파일.확장자`가 없는 줄)을 세서 카드(`suspect`·`unsourced`, 질문마다도)와 노트 머리에 싣고, 일 단계 노트에서는 그 줄만 빼고(`dropInstructionLines`, 뺀 줄 수 한 줄) 회의 노트에는 경고를 단다. 카드의 `textOnly`(도구는 있는데 읽기 전용을 못 막는 AI)·`noTools`(도구 없는 AI)는 이어받기 사슬(`msg.aiChain`)까지 본다(`researchGuards`). 목표 회의 중 조사 결과 메시지에도 `flags`·`textOnly`·`noTools`. 준비 대목 답과 목표의 회의 차례는 넘기는 대화(`#historyList`·`#withHistory`·`#withMissed`·`#fullTalk`)에서 뺀다(`notTalk`). 목표 팀 회의 차례는 기억에 들어가고, 자기 CLI 대화를 이어 가는 에이전트에게도 `#recall` 이 그 사람의 한 번 실행 답은 빼지 않는다(대화에 없으니까). 목표 일 실행의 회의 차례(준비 회의와 팀의 회의 단계, 회의 중 조사 포함)도 `#runAgent` 가 `ctx.meet` 를 보고 한 번 실행으로 돌린다(프롬프트는 `#prompt` 의 fresh: 앞 대화 없이). 조사 노트(`researchNote`, 답마다 앞 1,200자)는 준비 회의와 일 단계에, 회의 결론(`conclusionPrompt`, 앞 2,000자)은 일 단계에 무작위 표식 안의 참고 자료로(`#prepRefs` 가 목표의 메시지 id 로 다시 만든다). 기준 판정·[이전 단계 결과]·`#reviewedBy` 에는 준비 대목을 넣지 않는다. 추가 지시는 일 단계부터. 대목 앞마다 호출 상한(훑어보기·질문 1, 조사는 안 끝난 질문 수, 회의는 `meetingCalls`). 목표 실행의 회의(준비 회의·팀 회의 단계)는 의견 끝에 입장 줄, 차례 발언에 이견을 먼저 적고 입장을 바꾼 이유를 적으라는 말, 차례·판정·결론에 "[네가 앞에서 한 말]"을 남의 말과 따로(경고 문장도 그렇게), 반대편에는 가장 강한 주장을 근거로 반박하라는 말을 넣는다(`#meetingPrompt` 의 `goalMeet`). 건너뛸 차례가 판정 한 번보다 많이 들면(`firstJudge`) 1바퀴 뒤에 진행자가 반대편을 포함한 모두의 입장이 같은지 판정하고(`meet.first`), 합의면 차례 바퀴 없이 결론(진행 기록 한 줄). 차례 바퀴 뒤 판정은 지금처럼 반대편을 뺀다. 호출 수 식에 그 판정을 넣고(`meetingCalls`), 합의로 줄어든 수는 `meetingCallsMin`(카드의 `meeting.fewer`). 목표 안의 팀 회의 단계도 `meetingCalls` 로 본다(끊긴 회의를 이어서 할 때도 1바퀴부터라 같은 식. 회의 아닌 단계를 이어서 하면 다시 돌릴 사람 수). 남은 호출이 상한의 4분의 1 아래면 목표 회의의 회의 중 조사를 끈다(`check.status: 'low'`, 회의마다 진행 기록 한 줄). 조사 담당의 AI(직접 정한 AI)가 구독 한도 임박이어도 끈다(`'near'`, 결정 0022). 끊김: `at.phase` 가 준비 대목이면 그 대목부터(끝난 대목은 안 돌고, 조사는 안 끝난 질문만, 회의는 1바퀴부터, 호출 상한 대기만 다시 묻는다).
- 일 카드(결정 0018): 목표 카드의 `work`(`workCard`/`cardsProblem`: 승인 관문·회의 단계가 있거나 검수 역할이 아닌 팀원이 한 명 이하면 못 씀). 확인의 `work: 'cards'` → 단계표 = [준비 대목…][계획 `mission:'plan'`][빈 일 자리][기준 판정]. 계획(`#planStage`): 진행자 한 번 실행(읽기 전용, `prep: { kind:'plan' }`)으로 맨 끝 ```oc-cards 블록 → `cleanPlan`(2~6장, k1… 번호는 코드, needs 는 앞 카드만) → `matchOwners`(없는 이름이면 한 번 다시, 그래도 없으면 `fallbackOwner`) → 블록을 못 읽으면 한 번 다시, 그래도 안 되면 카드 하나 → `mission.cards`, 빈 자리를 `waveStages(planWaves(cards))`로 바꾸고 계획 카드. 단계 나누기: needs 가 앞 단계에서 끝난 카드끼리, 같은 담당은 한 단계에 하나, files 가 겹치면 다른 단계, 파일 없는 build·write 카드는 혼자. 카드 단계는 `#runStage` 그대로(보통 실행), 담당마다 `cardPrompt`(표식 안 카드 글 + 기다린 카드의 꼬리·결과 1,500자) + 끝의 두 칸(`tailRule`) + 막힘 출구(`blockedRule`, 단계표 방식 일 단계에도). `#cardGate`: 되풀이 상한(카드 하나 3번, 넘으면 `hold mission/limit`)과 시간당 시작 수(20장, `hold cap/rate`). `#cardsAfter`: 상태·꼬리(없으면 한 번 다시, 그래도 없으면 hole)·막힘. 막힘(`#blockedOf`·`#blockedAsk`, `hold mission/blocked`): 받아들이기 = 막힌 일만 빼고(카드는 hole, by 'blocked', 답에 blockedBlock.accepted) 나머지로 판정까지 / 한 번 더 = 막힌 사람만 / 그만. 오류 다시 하기는 오류 난 카드만. 되돌림은 마지막 카드 단계. 이어서: `at.phase 'plan'` 이면 계획부터, 그 뒤면 저장된 카드로(다시 계획하지 않는다), 카드 담당이 팀에 없거나 일 카드를 못 쓰게 되면 409.
- 호출 어림과 한도 대기(결정 0019): 목표 카드에 `estimate`(`estimateParts`: 목표 잡기에 이미 쓴 호출, 조사 3~8·회의(1바퀴 합의 수~회의 호출 수 + 회의 중 조사 최대 3)는 `prepCard` 값, 단계표면 팀 단계마다 인원(회의 단계는 `meetingCallsMin`~`meetingCalls`, 되돌림 때는 진행자 1명)과 검수 단계 여부·뺄 수 있는지, 일 카드면 계획 1 + 카드 1~6장과 마지막 카드 단계 최대 명단 수, 검수자가 있으면 판정 1과 자동 되돌림 `RETURN_CAP`)과 `providers`. 화면과 서버는 같은 `sumEstimate`(public/js/mission-numbers.js)로 더한다: 남은 단계 = 빠질 수 있는 단계 중 남긴 것만, 되돌릴 단계 = 남은 단계 중 검수 단계가 아닌 마지막(없으면 남은 마지막. `reviewPlan` 과 같다), 최대 = 최소 + 되돌림 × (그 단계 + 판정). 팀이 바뀌어 확인이 409 면 지금 팀의 조각(`estimate`)도 준다. 확인 요청은 화면이 보던 범위(`estimate: { min, max }`)도 보내고, 지금 팀으로 다시 센 값과 다르면 같은 409(다른 대조에 안 걸리는 팀 변경. 없는 요청은 대조하지 않는다). 확인할 때 `estimateCalls` 로 `mission.estimate` 를 적고, 끝난 카드(done·accepted·stopped)는 실제 `calls.used` 옆에 보인다. 구독 한도 줄은 화면이 이미 받은 `state.usage.limits` 에서 `limitRows`(사용률이 숫자이고 초기화 시각이 없거나 미래인 창만, 창 이름은 세션 화면의 `WIN_LABEL`, 기록 나이는 `recordAge`: 분·시간·일, 하루 넘으면 오래된 기록)로 그리고 새로 읽지 않는다. 한도 대기: 목표 일 실행의 일 단계(단계표·카드, 준비 대목·회의 단계·계획은 빼고)에서 실패한 사람이 모두 `isQuotaError` 이거나(이어받기가 다 실패한 뒤) 기준 판정이 한도로 끝나면 `#quotaAsk` 가 `hold.reason: 'quota'` 로 묻는다. 초기화 시각(`#quotaUntil`): 한 사람마다 마지막으로 실제로 돈(한도에 걸린) AI 의 `limitResetAt`(100% 이상이거나 거절 기록의 창만. 이어받기 기준 95%가 아니다)과 `resetFromText` 중 늦은 쪽, 없으면 오류 문구로 표시한 `Cooldown`(source 'text'), 사람끼리는 늦은 쪽, 한 사람이라도 모르면 0(이어서 할 때는 저장된 시각, 지났으면 `passed`). 보기 순서: later(시각을 알 때만) · retry · skip(일 단계)/accept(판정) · stop. later 면 `quotaDelay`(그 시각 + `QUOTA_SLACK` 45초, `OFFICE_CREW_FAKE_ONLY` 가 켜졌을 때만 `OFFICE_CREW_QUOTA_RESUME_MS`)의 메모리 타이머(`quotaTimers`, 대기가 끝나면 지운다)가 retry 를 보낸다(같은 `hold.at` 으로 다시 띄워 알림을 다시 보내지 않는다). 타이머가 울릴 때 일시정지를 눌러 뒀으면 일시정지 대기부터(거기서 그만이면 사무실 표시도 '중지됨'으로). 다시 하기 앞에 `#capCheck`(모자라면 "20번 더", 끝낸 답은 끊긴 자리에 남긴다). 자동은 실제로 다시 시작할 때만 세고 `QUOTA_AUTO`(3)번까지(`mission.quota.autos`). retry 는 일 단계면 한도에 걸린 사람만 다시 돌고 끝낸 답은 그대로(일 카드는 카드 시작 수·시간당 수에 세지 않는다), 판정이면 같은 회차를 처음부터(한도로 끊긴 판정 답은 `review.quota`). skip 은 오류 대기의 skip 과 같고 일 카드면 그 카드를 구멍(`by: 'quota'`, 뒤 카드엔 결과 없음, 검수 자료엔 빈 결과라는 코드의 줄. 줄은 카드 표시로 만들고 그 담당의 답은 결과로 넣지 않는다. 카드가 전부 그렇게 빠진 카드 단계는 건너뜀). accept 는 이번 회차를 판정 없음으로 적고 받아들임으로 끝낸다(`ctx.quotaAccept`). stop 이면 사무실 표시를 '중지됨'으로. 진행 기록 `quota`(fail outside)·`answer` 줄. 끊긴 자리 `wait: { reason: 'quota', until, failed }`: 이어서 하면 호출 없이 같은 대기를 다시 띄운다(일 단계는 `#runStage` 의 resume, 판정은 `#missionRun`. 저장된 오류 문구로 한도인지 다시 판정하지 않는다). 다시 하기 앞 상한 대기는 `wait: { reason: 'cap', quota: true }`(이어서 하면 끝내지 못한 사람만 다시 돌고 일 카드는 `#cardGate` 를 건너뛰어 시작 수에 세지 않는다). 사이드바·알림 종류 `quota`.
- 구독 한도 % 상한(결정 0026, 설정 `limitCap` 기본 90, 0 = 끔): 목표 일 실행에서 새 일(훑어보기·조사 질문·조사·준비 회의·계획·일 단계·카드 단계·기준 판정)을 시작하기 직전, 호출 상한 검사 바로 뒤에 `#limitCheck`. 그 일을 돌 에이전트마다 실제로 돌 AI 를 `#capTarget` 이 `#route` 와 같은 판단으로 기다림·상태 표시 없이 미리 보고(직접 정한 AI 가 쉬는 중·이어받기 기준% 이상·하루 예산을 다 썼으면 이어받기 설정대로 다른 AI, 없으면 그대로. 곧 풀려 기다릴 AI(`waitForResetMin`)는 보지 않는다. 자동 라우팅이면 지금 고를 AI), 그 AI 의 한도 기록에서 사용률이 숫자이고 아직 안 풀린 창 중 상한 이상인 것(`overCap`, "지금 다시 쓰기"로 푼 기록은 빼고)이 있으면 `hold.reason: 'limitcap'` 으로 묻는다: 계속(`accept`, 그 AI 를 `mission.capOk` 에 넣어 이 목표에서 다시 묻지 않음) · 초기화 뒤 이어서(`later`, 넘은 창이 모두 초기화 시각을 알 때만, `quotaDelay` 타이머·`mission.quota.autos`·`QUOTA_AUTO` 를 한도 대기와 같이 쓴다. 울리면 다시 보고 넘은 창이 없으면 시작하며 그때만 센다. 일시정지를 눌러 뒀으면 일시정지 대기부터) · 그만. 한도 대기(0019)에서 그만 말고 다른 걸 고르면 그 AI 도 `capOk`(한 한도에 두 번 묻지 않게), 한도 대기 뒤 다시 하기 앞(`first.quota`)과 끊긴 대기부터 다시 묻는 바퀴에서는 보지 않는다. 사용률 숫자를 주지 않는 AI 는 대상이 아니다. 한도가 이미 다 찬 AI(`#capFull`: 100% 이상·거절 기록의 창이 안 풀림(`limitResetAt`), 초기화 시각 모르는 다 찬 창·창 모르는 거절 기록은 받은 뒤 30분(`avoidUntil` 기준 100))도 묻지 않고 한도 대기에 맡긴다. 회의(준비 회의·팀의 회의 단계)는 회의 중 조사 담당의 AI 도 본다(`#meetIds`, 단계 명단 밖일 수 있다). 일 카드의 끝 두 칸 다시 요청 앞에서는 보지 않는다(호출 상한만). 그 단계에서 이미 끝내 그대로 쓰는 답(이어서 한 첫 바퀴·막힘 "한 번 더"의 다음 바퀴)은 상한 질문과 호출 상한 질문의 끊긴 자리 `finished` 에 남긴다. 사용자가 고른 것(계속·초기화 뒤 이어서·그만)은 `userLine`(`by: 'user'`, 결정 0025). 끊긴 자리 `wait: { reason: 'limitcap' }`(준비 대목이면 `resumePoint` 가 그 대목 앞의 대기로 읽는다): 이어서 하면 같은 자리의 검사가 호출 없이 다시 묻는다(기록이 내려갔으면 묻지 않고 시작). 진행 기록 `limitcap`·`answer` 줄, 사이드바·알림 종류 `limitcap`. 목표 카드의 구독 한도 줄은 상한과 "상한 넘음" 칩을 같이 보인다. 칩은 서버가 같은 판단(`#capTarget`·`capOk`·`#capFull`)으로 센 `capAsk`(지금 일을 시작하면 물을 AI)만: 세션 조회와 `mission` 이벤트에 싣고(저장하지 않는다), 목표를 알릴 때·그 세션에 한도 기록이 올 때 다시 세어 바뀌면 다시 알린다. 목표가 아닌 보통 실행은 묻지 않는다.
- 구멍과 기록(결정 0022): 대목마다 받는 블록 표 `BLOCK_ACCEPTS`(goal: oc-goal·oc-ask / scan·research: 없음 / questions: oc-research / meeting: oc-verdict·oc-check / plan: oc-cards / work·cards: oc-blocked·oc-ask / review: oc-review)가 단일 근거다. 판정 답의 섞인 블록 거르기(`OTHER_BLOCK`)는 표의 블록 중 판정이 받지 않는 것에서 만든다(그전 정규식은 어느 대목도 쓰지 않는 이름을 보고 `oc-cards`·`oc-research` 를 놓쳤다). 블록을 읽는 곳은 그대로이고, 목표 실행의 답이 끝날 때(`#missionMsgLines`, 답의 대목은 `blockPart`) 표에 없는 블록이 있으면 진행 기록 `block` 한 줄(그 블록은 읽지 않는다). 블록은 여는 줄이 줄 맨 앞의 백틱 세 개 + 정확한 이름 + 줄 끝·공백일 때만 센다(`BLOCK_AT`, 섞인 블록 거르기도 같다). 표는 대목 단위라 같은 대목의 다른 차례만 읽는 블록(회의 의견의 `oc-verdict` 등)과 물을 수 없는 차례의 `oc-ask` 는 줄 없이 읽히지 않는다. 배정 기록: `#runAgent` 가 답마다 `msg.route`(`asked` 에이전트 설정·자동 라우팅이면 `auto`, `ran` 실제로 시작한 AI, `why` 는 `#route` 가 돌려준 `auto`·`near-limit`·`daily-budget`·`wait-reset`(기다린 뒤에도 막혔으면 이유는 기다린 뒤의 값으로), `#pace` 의 `daily-pace`, 이어받기의 `takeover`, 지운 Codex 계정이라 기본 Codex 로 돌면 `account-gone`)를 적고, 이어받으면 `messageMeta` 로 다시 보낸다. 목표 실행이면 이유에 `auto` 말고 다른 코드가 있을 때만 진행 기록 `route` 한 줄(자동 라우팅만은 답과 칩에만), 화면은 답 머리 모델 칩의 title(`routeTip`. 모델 칩이 없으면 AI 칩). 한도가 줄면 부가 일부터: `#nearLimit`(쉬는 중이거나 한도 창이 이어받기 기준% 이상·거절, `#route` 와 같은 기준)이면 인수인계 메모 자동 작성(`#autoNote`)을 건너뛰고 대화에 한 줄, 목표 회의 중 조사를 끈다(`near`. 차례마다 다시 보고 끈 이유가 바뀌거나 다시 켜지면 진행 기록 한 줄). 실패의 종류: 오류 대기 앞에 실패한 사람마다 진행 기록 `error` 한 줄(`#failLines`: 한도 오류 `outside`, 일 카드인데 기다린 앞 카드가 결과 없이 끝났으면 `input`, 그 밖 `unknown`. 이어서 같은 대기를 다시 물을 때는 다시 안 적는다), 훑어보기·조사 질문·조사 노트·계획·기준 판정 줄도 한도가 아닌 오류면 `unknown`, 이번에 막힘·구멍으로 끝난 카드가 기다린 앞 카드에 결과가 없었으면 `card` 줄 `input`(`#cardsAfter`. 막힘 대기에서 끊겼다 이어서 할 때는 끊기기 전에 판정한 카드를 다시 판정하지 않아 그 카드·막힘·묻는 줄을 다시 적지 않는다), `oc-blocked` 의 선택 칸 `kind`(unclear·input·capability·dependency, 그 밖·없음은 unknown)는 막힘 줄의 `agentKind` 와 대기의 `blocked[].kind` 로(화면은 "에이전트가 적음"과 같이). 출처 표시: 목표 일 실행의 일 단계·일 카드 답과 회의 결론의 답 머리에 "에이전트가 씀 · 사용자 확인 안 함"(`agentWrote`, 실행 기록이 잘렸으면 일 카드 답만). 묻고 할 일: 목표의 일 단계·일 카드 프롬프트(회의 단계를 되돌릴 때 혼자 고치는 진행자 차례 포함)에 `outsideRule`(밖으로 나가는 일과 작업 폴더 밖 지우기는 질문 블록으로 먼저 물어. 물을 수 없는 실행이면 하지 마), "[이어서]" 줄 뒤에 `resumeSent`. 글 지시라 코드로 막지 못한다.
- 완주 보고와 증거(결정 0025): 목표의 일 실행이 done·accepted·stopped 로 끝나면 `#missionEnd` 가 `#report` 로 `kind: 'report'` 카드 하나(`buildReport`, AI 호출 없음, `mission.reportMsgId` 로 한 번만. 끊긴 목표·확인 전에 닫힌 목표·버린 끊긴 목표에는 없다). 사실 먼저: 끝 상태(흐름 무대의 끝 깃발과 같은 말 `goalEndWord`), 확인부터 끝까지 시간, 실제 호출과 어림, 종류별 답 수(메시지 표시 `answerKind`. 오류·중지로 끝난 답도 세고 그 수는 `answerFails` 로 따로), 기준별 최종 판정(근거는 에이전트가 쓴 글로 200자), 사용자가 고른 것(사용자 선택을 적는 곳이 `userLine` 으로 단 `by: 'user'` 줄만. 표시가 하나도 없는 옛 기록은 confirm·answer, 말 메시지가 있는 note, 목표 카드를 가리키는 resume 줄), 확인 못 한 것(`unverifiedLines`), 실패 종류 수(판정이 한도로 끝난 사건의 quota·review 두 줄은 한 번), 배정이 다른 답 수, 회의 결론의 결정·남은 이견. 바뀐 파일은 `#gitChanged` 로 뒤에 채운다(`filesState`. 묻는 중에 앱이 꺼졌으면 세션을 다시 읽을 때 `#fixStale` 이 none 으로). 보고를 만들다 던지면 대화에 한 줄만 남기고 끝 처리는 그대로. 회의 결론: 목표 실행의 회의 결론 답이 끝나면 `#missionMsgLines` 가 `recordMeeting`(결론 프롬프트가 이미 부탁하는 다섯 머리말을 `conclusionParts` 가 네 언어로 읽는다. 들여 쓰지 않은 줄의 머리말만, 끝에서 거슬러 같은 칸이 다시 나오기 전까지의 마지막 묶음만. 마을 게시판의 "결정" 줄 읽기를 넓힌 것으로, 게시판도 마지막 결정 줄)으로 `mission.meetings` 에. 다음 대목에 넘기는 결론은 그대로 전문. 바꾼 파일 대조: 만들기·글 카드가 있는 카드 단계 앞뒤로 `gitState`(rev-parse --show-prefix·HEAD, status --porcelain -z(이름 바꾸기·복사는 옛 경로도)와 파일마다 수정 시각·크기(비동기 16개씩), git 하나에 3초)를 찍어 `changedSet`(그 사이 커밋이 생겼으면 `gitDiffNames`, --no-renames)으로 바뀐 파일을 구하고, 끝낸 카드가 꼬리에 적은 경로(`tailClaims`: 링크·백틱·괄호 앞 낱말, 조사·CJK 꼬리와 줄 번호를 떼고 경로처럼 보이는 것만)를 전부 경로로 읽었고 그중 하나도 안 바뀌었으면(`proofCheck`: 경로로 못 읽은 항목·"다음 카드가 알아야 할 것" 없음·8개 넘음은 판단 안 함, 같은 단계 다른 카드의 files 로 가르고, 폴더 밖·가를 수 없음·적은 게 없음은 판단 안 함, git 이 무시하는 파일은 적은 그대로의 경로로 수정 시각) 진행 기록 `proof`·카드 `proof`·검수 자료의 코드 한 줄(`PROOF_LINE`). 경고만. git 시간 상한·출력 8MB·수정 시각 읽기 3초를 넘기면 그 실행에서는 끄고 까닭을 나눠 한 줄(`ctx.proofOff`, `#proofOff`). 계획 뒤 어림: `#planStage` 가 계획 카드에 `planEstimate`(같은 `sumEstimate`), `#missionRun` 이 첫 카드 단계 앞에서 `#planCheck`(어림의 큰 쪽 > 남은 호출이면 `hold cap/plan` "20번 더", 끊긴 자리 `wait: { reason: 'cap', kind: 'plan' }` 이면 이어서 할 때 다시). 기억: 카드의 "기억에 넣기"(`reportMemory`)를 눌러야 `reportText`(사실과 기준별 결과만, 회의 결론·조사 노트 빼고, 머리에 출처와 "사용자가 확정하지 않은 기록")를 목표가 돈 폴더(`memFolder`)의 기억에 role `report` 로 넣는다(내 PC 모델만 받은 목표면 provider `local`. 넣었다는 표시를 기다리기 전에 세워 동시에 눌러도 한 번). 빼기는 `memory/<key>/hidden.json` 에 메시지 id 를 적어 검색에서만 뺀다(원문은 그대로, 다시 넣으면 되살린다. 기억 화면·배지는 뺀 보고 수를 따로 보인다. 깨진 hidden.json 은 덮어쓰지 않고 hidden.json.bad 로 옮긴 뒤 새로 시작하고 알린다).

### 문서로 팀 짜기(`server/teamdoc.js`, 결정 0024)
- 알아보기(`detectTeamDoc`): 채팅에서 보낸 말만, 도는 실행이 없을 때, 목표 모드·영입 감지보다 먼저. 한 줄·120자 이하·`/` 로 시작 안 함·@이름 없음, 팀 낱말이 만들기 동사의 목적어이고 말이 그 요청으로 끝나는 꼴(네 언어 정규식 `TEAM_KO`·`TEAM_EN`·`TEAM_ZH`·`TEAM_JA`. 팀과 동사 사이에 다른 명사가 끼거나 팀이 다른 낱말의 일부면 아님), 글 문서 첨부(.md·.markdown·.txt, 200KB 이하, 앞 3개) 1개 이상. 아니면 보통 메시지.
- 초안(`#teamDoc` → `#start` → `#teamDraft` → `writeTeamDraft`): 사용자 말에 `teamDoc`, 단계 하나("팀 초안")에 쓰는 사람(팀 진행자 → 세션 에이전트 → 설정 기본 에이전트. 가상 AI·로그인 안 된 AI·도구가 있는데 앱이 권한을 못 거는 AI(`safeWriter`, Hermes)는 건너뜀, 없으면 400) 혼자. `#prepOnce` 한 번 실행(`prep.kind 'team'`: 읽기 전용, 역할 노트·스킬·커넥터·첨부 그림 없음. `#runAgent` 가 자동 라우팅·이어받기로 실제로 고른 AI 도 `safeWriter` 로 다시 봐서 아니면 돌리지 않음). 프롬프트(`teamPrompt`) = 코드의 지시 + 사용자 요청 + 무작위 표식 안 문서 글(합쳐 60,000자, 넘으면 표시) + 로그인된 AI 목록(프로바이더마다 등급별 `MODELS_PER_TIER`=6개까지, 자르면 "… 줄였어" 한 줄) + 블록 모양. oc-team 블록을 못 읽으면 한 번 다시, 그래도 안 되면 system 한 줄(실행 자체가 실패하면 실패 문구). 멈추거나 앱이 꺼지면(`recover`) `#releaseTeamDoc` 이 `teamDoc` 을 풀어 보통 대화로 되돌리고 system 한 줄.
- 정리(`cleanTeamDraft`, 멱등: 저장본을 다시 정리하면 같다): 8명·8단계, 이름 겹침은 대조 열쇠(공백·전각·대소문자 무시)로 번호(`freeName`), 단계는 적힌 이름 그대로 → 열쇠 순으로 찾고 같은 구성 단계는 한 번, 길이는 만들 때와 같은 UTF-16 단위(반쪽 글자·끝 이음 글자 없음), 팀·단계 이름에 주입 무늬면 중립 이름 + `renamed`, 로그인된 진짜 AI 만(아니면 자동 라우팅 + 경고), 카탈로그 모델만(아니면 등급으로 가장 가까운 모델 + 경고, `said` 유지), 세기 clamp(+ 경고), 주입 무늬 경고, 권한·지침·도구·단계 지시·승인은 버림. 단계에 없는 사람은 등급순 "작업"·검수는 "검수" 단계로.
- 카드 처리(`resolveTeamProposal`): 만들기는 저장된 초안을 지금 AI 목록으로 다시 정리해 같을 때만 `cleanAgent`/`cleanTeam` 으로 만들고(에이전트 `tier`, 팀 `ladder`·`escalateAfter`), 고르면 세션 팀을 바꾼다. 다시 정리해 달라지면 409 문구가 실제 이유(AI 로그인·모델 목록 / 같은 이름의 에이전트)를 말한다. 그냥 보내기는 `sendProposed`(표시를 지우고 보통 실행).

### 이어갈 대화(resume)
- `providerSessions[agentId]`에 CLI 대화 id, `sessionProvider[agentId]`에 그 대화를 만든 프로바이더를 같이 저장한다. 지금 실행할 프로바이더가 다르면(자동 라우팅·이어받기로 바뀜) 이어하기를 하지 않는다.
- 이어갈 대화가 없거나 이어하기가 실패하면, 이 세션의 최근 대화(이번 실행의 앞 단계 결과는 제외)를 `[이전 대화]`로 프롬프트 앞에 넣어 맥락을 잇는다.
- 이어 간 Claude 대화는 첫 요청 때 기록한 시스템 지시를 압축 전까지 그대로 쓴다(Claude Code CLI 문서). 그래서 역할 노트가 바뀐 걸 알리는 처리는 프로바이더가 아니라 오케스트레이터가 바뀐 노트 블록만 프롬프트 앞에 붙인다(Codex·Claude 같다. 결정 0013 개정·0023).

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
GET  /api/sessions/:id               전체 세션(+ capAsk: 목표 카드의 "상한 넘음" 칩을 달 AI, 결정 0026)
POST /api/sessions                   {title?, teamId?, agentId?, cwd?}
PATCH/DELETE /api/sessions/:id
POST /api/sessions/:id/messages      {text, attachments:[id], mention?}  목표가 도는 중이면 → {noted, messageId, late?}(결정 0014)
POST /api/sessions/:id/control      {action, runId?, agentId?, text?}  목표의 판정 뒤 묻기(mission)·호출 상한(cap) 대기에는 accept·more·stop(결정 0015), 한도 대기(quota)에는 later(초기화 뒤 자동 이어서. 시각을 알고 3번이 안 찼고 아직 안 골랐을 때만)·retry(지금 다시)·skip(일 단계만)·accept(판정만)·stop(결정 0019), 구독 한도 상한(limitcap)에는 accept(계속)·later·stop(retry 는 자동 이어서 타이머가 다시 보게 한다. 결정 0026). 확인 409 에는 지금 팀의 어림 조각 estimate 도 싣는다. 대기 사유에 맞지 않는 동작은 {ok:false}
PATCH /api/sessions/:id {goalMode}   목표 모드 켜기·끄기(쓸 수 없으면 400 과 이유, 살아 있는 목표가 있으면 끄기·teamId 변경 409. 쓸 수 없는 팀으로 바꿔 저절로 꺼지면 응답에 goalModeOff: 이유. 결정 0014)
POST /api/sessions/:id/mission/confirm {missionId, expected:{goal, criteria, outOfScope, userDecides, checks?, keep?}, edited?, review?:{reviewerId, droppable:[카드가 보여 준 목록], drop:[팀 단계 번호]}, prep?, work?:'cards'|'stages', estimate?:{min, max}(화면이 보던 호출 어림, 결정 0019)}
                                     본 것과 저장된 초안이 다르면 409 + {draft}, 검수 줄이 지금 계산과 다르면 409 + {review}(결정 0015), 일 카드를 지금 팀으로 못 쓰면 409 + {work}(결정 0018). 옛 목표·처리한 카드·실행 중·마지막 카드 아님·카드 뒤 사용자 말은 409, 기준 0개·섞인 팀은 400
POST /api/sessions/:id/mission/cancel {missionId}   카드 대기 목표 닫기,  POST …/mission/discard {missionId}  끊긴 목표 버리기
POST /api/sessions/:id/report/:mid/memory {on}   완주 보고를 프로젝트 기억에 넣기(on: true)·빼기(false, 검색에서만 뺀다). 보고가 아니면 404, 기억이 꺼졌거나 넣은 적 없이 빼기면 409(결정 0025)
POST /api/sessions/:id/mission/resume {missionId}   끊긴 목표를 끊긴 자리부터 이어서(결정 0016). 다른 목표·cut 아님·실행 중·요청 없음·끊긴 자리 없음·끊긴 실행 기록 없음·팀이 바뀜(이유: 무엇이 다른지)은 409, 섞인 팀은 400
POST /api/sessions/:id/proposals/:mid  영입 제안 카드와 팀 제안 카드만(그 밖의 kind 는 409). 팀 제안의 accept 는 {rev, permission?, permissions?:{[번호]: 권한}, switchTeam?}만 받는다:
                                     판이 다르거나 저장된 초안을 지금 AI 목록으로 다시 정리해 달라지면 409 + {draft}(카드도 새 초안·판 +1), 목표가 살아 있는데 팀을 바꾸면 409(결정 0024)
POST /api/sessions/:id/handoff      {agentId?} 인수인계 메모 쓰게 하기(AI 호출 1번, 결정 0008). 쓰는 중이면 409
                                    데이터 폴더의 handoff/<세션>/ 에 불러온 대화 원문(import.jsonl)과 다른 AI에게 건네는 대화 전체 파일(cloud/)을 둔다(server/handoff.js)
POST /api/uploads                    (바이너리 본문, X-File-Name) → {id,name,mime,size}
GET  /api/uploads/:id
GET/PUT /api/settings               (apiKeys·authMode·failover·acpAgents 검증, 일부만 보내도 나머지 유지. limitCap 0~100 정수(숫자가 아니면 90)·savings normal|lean, 결정 0026)
POST /api/agents/fixed-text          {id?, name, role, systemPrompt, skills, provider, permission} → {chars, skills, heavy, skillList}: 저장 전 값으로 센 시스템 지시 글자 수와 스킬 본문 몫(10,000자 이상이면 heavy). 스킬 본문은 보내지 않는다(결정 0026)
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
- 모델(`stageModel({ run, live, mission, questions, agents, team, solo, conn, now, prev, request })`): 역 = 마지막 실행의 단계(실행이 없으면 팀 단계표를 할 일로, 팀이 없으면 에이전트 하나, 목표 카드 확인 대기면 팀 단계표를 할 일로). 역 상태 todo·run·done·wait·limit·error·skipped·stopped·cut(목표의 판정 뒤 묻기·한도 대기 단계는 wait, 자동 이어서를 고른 한도 대기는 limit, 끊긴 목표의 멈춘 단계는 cut). 사람 상태는 지금 역(과 대기가 가리키는 역)에만: think·write·tool(search·read·run·edit·other)·meet·wait·limit·error·done·off·idle, 회의는 `meetingNow` 로 진행자·반대편·말하는 사람·조사하러 간 빈자리. 역마다 4명(넘으면 +n), 역 6개를 넘으면 지금 역 하나 앞까지 남기고 지난 역을 접는다. 내 차례(`ask.kind`)와 문 자리(서버가 묻는 때): approve = 그 단계 뒤, verdict·notes = 판정 역 뒤, blocked = 막힌 일 단계 뒤, cap·limit(카드 되풀이 상한)·limitcap(구독 한도 상한, 결정 0026) = 그 단계 앞(역을 기다림으로 칠하지 않는다. 서버가 대기에 ran 을 단 이미 돈 단계면 그 역 안. limitcap 에서 자동 이어서를 고르면 내 차례가 아니라 한도 대기 줄), error·quota·question = 역 안, confirm = 맨 앞, cut = 전체 점선, paused = 알약만. "지금" 줄·한도 알약은 지금 단계·대기 단계의 담당과 조사 간 사람만 본다. 지워진 에이전트는 "삭제된 에이전트"(누를 수 없음). `prev` 와 지금 단계가 다르면 `fly`(hand, 거꾸로면 ret).
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
