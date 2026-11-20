// 역할 노트: 에이전트마다 "이 역할이 하는 일"과 배운 것(항목)을 데이터 폴더의 notes/<agentId>.json 파일 하나에 둔다(결정 0013).
// - 사용자가 쓴 항목만 바로 확정이다. 에이전트·바깥 자료에서 온 항목은 언제나 초안으로 들어오고, 사용자가 받아야 다음 일에 들어간다
// - 지우지 않는다(보관). 모든 변경은 기록(log)에 전·후 값과 함께 남고, 하나씩 되돌릴 수 있다
// - 에이전트·바깥 자료의 글은 지시가 아니라 참고 자료다: 저장 전에 흔한 주입 무늬를 거르고(모든 무늬를 잡지는 못한다),
//   프롬프트에는 무작위 표식 안에 넣는다(orchestrator.js #system)
// - 바꿀 때마다 파일을 새로 읽고, 고친 뒤 임시 파일에 써서 이름을 바꾼다. 읽기·고치기·쓰기가 한 번에(동기로) 끝나서
//   같은 노트를 고치는 요청이 겹쳐도 앞 변경을 덮어 잃지 않는다
import fs from 'node:fs';
import path from 'node:path';
import { newId, writeAtomic } from './store.js';
import { tokenize, queryTerms } from './memory.js';
import { tr } from './i18n.js';

export const TEXT_MAX = 400; // 항목 글 최대 글자 수
export const LOG_MAX = 200; // 남겨 두는 변경 기록 수
export const TASK_MAX = 8; // 이 역할이 하는 일 최대 개수
export const TITLE_MAX = 80; // 일 제목 최대 글자 수
export const TASK_TEXT_MAX = 200; // 끝났다고 볼 기준·확인 방법 각각의 최대 글자 수
export const PROMPT_LIMIT = 2000; // 한 번 실행에 넣는 항목 글자 수 합의 상한(항목 글 + 프롬프트에 찍는 출처 주소)
const REF_MAX = 300; // 바깥 자료 주소·파일 이름 최대 글자 수
export const PROMPT_REF_MAX = 120; // 프롬프트에 찍는 출처 주소 최대 글자 수(넘으면 잘라 … 을 붙인다)
export const KINDS = ['method', 'pitfall', 'criterion', 'tool'];
const SOURCES = ['user', 'agent', 'web'];
const STATUSES = ['draft', 'confirmed', 'archived'];
// 상태를 바꿀 수 있는 길(PATCH). 에이전트·바깥 자료 항목: 초안 → 확정·보관, 확정 → 보관, 보관 → 초안(다시 받아야 들어간다). 사용자 항목: 확정 ↔ 보관.
// 되돌리기(undo)는 이 표를 따르지 않고 전 값으로 돌린다
const MOVES = {
  user: { confirmed: ['archived'], archived: ['confirmed'] },
  other: { draft: ['confirmed', 'archived'], confirmed: ['archived'], archived: ['draft'] },
};

const fail = (status, message) => Object.assign(new Error(message), { status });

// 글자 수: 사람이 보는 글자 단위(👍🏽·👨‍👩‍👧 같은 이모지 하나 = 1). 화면(views/rolenotes.js)도 같은 방법으로 센다
const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
export function chars(s) {
  const str = String(s ?? '');
  return graphemes ? [...graphemes.segment(str)].length : [...str].length;
}
// 프롬프트에 찍는 출처 주소: 바깥 자료 항목만(에이전트 항목은 주소를 찍지 않는다), 한 줄로, PROMPT_REF_MAX 자까지. 화면(views/rolenotes.js)도 같은 방법으로 센다
export function promptRef(x) {
  if (x?.source?.type !== 'web') return '';
  const str = String(x.source.ref ?? '').replace(/\s+/g, ' ').trim();
  const p = graphemes ? [...graphemes.segment(str)].map((g) => g.segment) : [...str];
  return p.length > PROMPT_REF_MAX ? `${p.slice(0, PROMPT_REF_MAX).join('')}…` : str;
}
// 아주 긴 글은 글자를 세기 전에 거른다(글자 하나가 UTF-16 으로 16칸을 넘는 일은 없다고 본다)
const over = (s, max) => s.length > max * 16 || chars(s) > max;

// 보이지 않는 글자: 폭 없는 공백·글 방향 바꾸기·태그 문자·글자 꾸밈 선택자처럼 화면에는 안 보이는데 AI는 읽는 것.
// 이모지를 잇는 ZWJ(U+200D)와 이모지 모양 선택자(U+FE0F)는 이모지 안에서 쓰이므로, 이모지 사이에 있는 ZWJ 와 FE0F 는 둔다
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0E\uFEFF\uFFA0\uFFF9-\uFFFB\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const STRAY_ZWJ = /(?<!\p{Extended_Pictographic}\uFE0F?[\u{1F3FB}-\u{1F3FF}]?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;
// 제어 문자: 줄바꿈·탭을 뺀 C0·C1 제어 문자와 줄·문단 나눔 문자
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/gu;
export const strip = (s) => String(s ?? '').replace(INVISIBLE, '').replace(STRAY_ZWJ, '').replace(CONTROL, '');
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const cleanText = (s) => strip(s).replace(/\r\n?/g, '\n').trim();

// 흔한 주입 무늬(에이전트·바깥 자료에서 온 글에만 쓴다). 넓게 잡아서 평범한 글이 걸릴 수도 있다: 걸리면 저장하지 않고 이유를 돌려준다
const INJECTION = [
  ['ignore', [
    /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}\b(?:instructions?|rules|directions|prompts?|guidelines|guardrails|polic(?:y|ies))\b/i,
    /\b(?:ignore|disregard|forget)\s+(?:all\s+|everything\s+)?(?:the\s+)?(?:above|previous|prior|earlier)\b/i,
    /(?:지시|지침|명령|규칙|프롬프트)[^.!?\n]{0,15}(?:무시|잊어|잊고|잊으|어겨|어기|따르지\s*마|따르지\s*말)/,
    /(?:忽略|无视|無視|忘记|忘掉|绕过|繞過)[^。！？!?\n]{0,15}(?:指令|指示|提示|规则|規則|要求)/,
    /(?:指示|命令|ルール|プロンプト|指令)[^。！？!?\n]{0,15}(?:無視|忘れ)/,
  ]],
  ['system', [
    /\b(?:system|developer)\s*(?:prompt|message|instructions?)\b/i,
    /<\/?\s*(?:system|instructions?|im_start|im_end)\b[^>]*>/i,
    // 앱이 시스템 지시를 감싸는 태그(<역할 지침>, 번역된 이름 포함)를 흉내 낸 것. 전각 ＜ ＞ 도 NFKC 로 같은 글자가 된다
    /<\/?\s*(?:역할\s*지침|role\s+instructions?|角色指令|役割の指示)\s*>/i,
    /<\|\s*im_(?:start|end)\s*\|>/i,
    /\[\/?(?:system|INST)\]/i,
    /시스템\s*(?:지시|지침|프롬프트|메시지|명령)/,
    /(?:系统|系統)\s*(?:提示|指令|消息|訊息)/,
    /システム\s*(?:プロンプト|メッセージ|指示)/,
  ]],
  ['permission', [
    /\b(?:grant|give|escalate|elevate|expand|raise|widen|increase|unlock|bypass|disable|turn\s+off)\b[^.!?\n]{0,30}\b(?:permissions?|privileges?|sandbox(?:ing)?|approvals?|full\s+access|admin(?:istrator)?\s+(?:rights|access))\b/i,
    /--dangerously|\bbypass[\s_-]*permissions\b|\bskip[\s_-]*permissions\b|\byolo\b/i,
    /(?:권한|허가|승인|샌드박스)[^.!?\n]{0,12}(?:넓혀|넓히|넓게|올려|올리|높여|높이|풀어|끄고|꺼|우회|건너뛰|부여|확대|해제)/,
    /(?:提升|扩大|擴大|提高|绕过|繞過|关闭|關閉)[^。！？!?\n]{0,10}(?:权限|權限|沙箱|审批|審批)/,
    /(?:权限|權限)[^。！？!?\n]{0,10}(?:提升|扩大|擴大|提高|绕过|繞過|放开|放開)/,
    /(?:権限|許可|承認|サンドボックス)[^。！？!?\n]{0,12}(?:上げ|拡大|昇格|広げ|回避|外し|無効)/,
  ]],
  ['secret', [
    /\b(?:send|post|upload|exfiltrate|leak|forward|transmit|e-?mail|share|reveal|expose|paste|curl|wget)\b[^.!?\n]{0,40}\b(?:secrets?|api[\s_-]*keys?|access[\s_-]*keys?|private[\s_-]*keys?|ssh[\s_-]*keys?|tokens?|passwords?|passwd|credentials?|cookies?)\b/i,
    /\b(?:send|post|upload|exfiltrate|leak|forward|transmit|e-?mail|share|reveal|expose|paste|curl|wget)\b[^!?\n]{0,40}\.env\b/i,
    /(?:비밀|API\s*키|비밀\s*키|개인\s*키|액세스\s*키|접근\s*키|토큰|비밀번호|암호|자격\s*증명|쿠키|\.env)[^.!?\n]{0,15}(?:보내|전송|올려|업로드|유출|넘겨|공유|붙여\s*넣)/i,
    /(?:发送|發送|上传|上傳|泄露|洩露|分享|发给|發給)[^。！？!?\n]{0,15}(?:密钥|密鑰|令牌|密码|密碼|凭据|憑據|凭证|憑證|cookie)/i,
    /(?:密钥|密鑰|令牌|密码|密碼|凭据|憑據|凭证|憑證)[^。！？!?\n]{0,15}(?:发送|發送|上传|上傳|泄露|洩露|分享|发给|發給)/,
    /(?:キー|トークン|パスワード|秘密|認証情報|クッキー)[^。！？!?\n]{0,15}(?:送信|送っ|送る|送れ|アップロード|漏ら|共有)/,
  ]],
];
const WHY = {
  invisible: () => tr('보이지 않는 글자가 있어서 저장하지 않았어.'),
  control: () => tr('제어 문자가 있어서 저장하지 않았어.'),
  ignore: () => tr('지시를 무시하라는 문장이 있어서 저장하지 않았어.'),
  system: () => tr('시스템 지시를 흉내 내는 문장이 있어서 저장하지 않았어.'),
  permission: () => tr('권한을 넓히라는 문장이 있어서 저장하지 않았어.'),
  secret: () => tr('비밀·키·토큰을 보내라는 문장이 있어서 저장하지 않았어.'),
};

// 걸린 무늬의 종류: 'invisible'|'control'|'ignore'|'system'|'permission'|'secret', 없으면 ''(목표 카드의 경고처럼 이유 문장이 달라야 하는 곳이 쓴다)
export function suspiciousKind(text) {
  const s = String(text ?? '');
  if (s.search(INVISIBLE) !== -1 || s.search(STRAY_ZWJ) !== -1) return 'invisible';
  if (s.search(CONTROL) !== -1) return 'control';
  const n = s.normalize('NFKC'); // 전각 글자(ｉｇｎｏｒｅ)도 같은 글자로 본다
  for (const [k, list] of INJECTION) if (list.some((re) => re.test(n))) return k;
  return '';
}

// 에이전트·바깥 자료에서 온 글을 저장해도 되는지: 안 되면 이유(글), 되면 ''
export function suspicious(text) {
  const k = suspiciousKind(text);
  return k ? WHY[k]() : '';
}

function checkText(body) {
  if (!body) throw fail(400, tr('역할 노트 항목 글이 비어 있어.'));
  if (over(body, TEXT_MAX)) throw fail(400, tr('역할 노트 항목은 {max}자까지야.', { max: TEXT_MAX }));
  return body;
}

// 출처: 없으면 사용자(코드에서 바로 부를 때만. HTTP 주소는 출처를 꼭 받는다). 에이전트·바깥 자료면 ref(주소나 파일)를 한 줄로 남긴다.
// 사용자 항목은 채팅에서 고른 글의 자리(chat:<세션 id>/<메시지 id>)만 남기고 그 밖의 ref 는 비운다
function cleanSource(src) {
  if (src === undefined || src === null) return { type: 'user', ref: '' };
  const type = typeof src === 'object' ? src.type : undefined;
  if (!SOURCES.includes(type)) throw fail(400, tr('모르는 출처야: {type}', { type: String(type ?? src).slice(0, 20) }));
  const ref = oneLine(strip(typeof src.ref === 'string' ? src.ref : ''));
  if (type === 'user' && !ref.startsWith('chat:')) return { type, ref: '' };
  if (over(ref, REF_MAX)) throw fail(400, tr('출처 주소는 {max}자까지야.', { max: REF_MAX }));
  return { type, ref };
}

function cleanTasks(tasks) {
  if (!Array.isArray(tasks)) throw fail(400, tr('하는 일 목록 형식이 맞지 않아.'));
  if (tasks.length > TASK_MAX) throw fail(400, tr('하는 일은 {max}개까지야.', { max: TASK_MAX }));
  const ids = new Set();
  return tasks.map((x) => {
    const o = x && typeof x === 'object' ? x : {};
    const [title, done, check] = [o.title, o.done, o.check].map((v) => oneLine(strip(typeof v === 'string' ? v : '')));
    if (!title || over(title, TITLE_MAX)) throw fail(400, tr('하는 일의 제목은 1~{max}자야.', { max: TITLE_MAX }));
    if (over(done, TASK_TEXT_MAX) || over(check, TASK_TEXT_MAX)) throw fail(400, tr('끝났다고 볼 기준과 확인 방법은 각각 {max}자까지야.', { max: TASK_TEXT_MAX }));
    const id = typeof o.id === 'string' && /^[\w-]{1,40}$/.test(o.id) && !ids.has(o.id) ? o.id : newId('task');
    ids.add(id);
    return { id, title, done, check };
  });
}

const empty = () => ({ version: 1, role: { tasks: [] }, items: [], log: [] });
// 읽은 파일을 정해진 모양으로(모르는 필드는 그대로 둔다)
function shape(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return empty();
  return {
    ...j, version: j.version || 1,
    role: { ...(j.role && typeof j.role === 'object' ? j.role : {}), tasks: Array.isArray(j.role?.tasks) ? j.role.tasks : [] },
    items: Array.isArray(j.items) ? j.items.filter((x) => x && typeof x === 'object' && x.id) : [],
    log: Array.isArray(j.log) ? j.log.filter((x) => x && typeof x === 'object' && x.id) : [],
  };
}

// 한 기록이 건드린 것: 하는 일 목록이면 '#role', 일괄 받기면 그 항목들, 나머지는 그 항목
const touched = (e) => (e.after && typeof e.after === 'object' && 'tasks' in e.after ? ['#role'] : Array.isArray(e.after?.ids) ? e.after.ids : [e.itemId]);

export class NoteStore {
  constructor(dir) { this.dir = dir; }

  // 에이전트 id 가 파일 이름으로 안전할 때만 경로를 준다
  #file(agentId, tail = '') { return /^[\w-]{1,80}$/.test(String(agentId ?? '')) ? path.join(this.dir, `${agentId}${tail}.json`) : null; }

  #read(agentId) {
    const f = this.#file(agentId);
    if (!f) return empty();
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return empty();
      throw fail(500, tr('역할 노트 파일을 읽지 못했어: {msg}', { msg: e.code || e.message }));
    }
    // 깨진 파일은 빈 노트로 덮어쓰지 않는다(읽을 수 없으면 바꾸지도 않는다)
    try { return shape(JSON.parse(raw)); } catch { throw fail(500, tr('역할 노트 파일이 깨져서 읽지 못했어. 덮어쓰지 않으려고 바꾸지 않았어.')); }
  }

  #write(agentId, n) {
    const f = this.#file(agentId);
    if (!f) throw fail(400, tr('에이전트 id 형식이 맞지 않아.'));
    // 쓰기 오류 글에는 파일의 절대 경로가 들어 있어서, 응답에는 오류 코드만 싣는다
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(f, JSON.stringify(n, null, 2));
    } catch (e) { throw fail(500, tr('역할 노트를 저장하지 못했어 ({code}).', { code: String(e.code || 'EIO').slice(0, 20) })); }
  }

  #log(n, { op, itemId = null, before = null, after = null, undoOf = null }) {
    n.log.push({ id: newId('log'), at: Date.now(), op, itemId, before, after, ...(undoOf ? { undoOf } : {}) });
    if (n.log.length > LOG_MAX) n.log = n.log.slice(-LOG_MAX);
  }

  get(agentId) { return this.#read(agentId); }

  // 초안 수와 확정 수(목록 표시용). 파일을 못 읽어도 0 으로 둔다
  counts(agentId) {
    try {
      const { items } = this.#read(agentId);
      return { drafts: items.filter((x) => x.status === 'draft').length, confirmed: items.filter((x) => x.status === 'confirmed').length };
    } catch { return { drafts: 0, confirmed: 0 }; }
  }

  setRole(agentId, tasks) {
    const next = cleanTasks(tasks);
    const n = this.#read(agentId);
    if (JSON.stringify(n.role.tasks) === JSON.stringify(next)) return n; // 바뀐 게 없으면 기록하지 않는다
    this.#log(n, { op: 'role', before: { tasks: n.role.tasks }, after: { tasks: next } });
    n.role.tasks = next;
    this.#write(agentId, n);
    return n;
  }

  addItem(agentId, { kind, text, source, localOnly } = {}) {
    const src = cleanSource(source);
    if (localOnly !== undefined && typeof localOnly !== 'boolean') throw fail(400, tr('localOnly 는 true 나 false 여야 해.'));
    // 채팅에서 고른 글(사용자 항목이지만 에이전트가 쓴 글)도 에이전트 항목처럼 거른다. 걸리면 직접 써 넣는 길을 알려 준다
    const chat = src.type === 'user' && src.ref.startsWith('chat:');
    if (src.type !== 'user' || chat) {
      const why = suspicious(text) || (chat ? '' : suspicious(source?.ref));
      if (why) throw fail(400, chat ? `${why} ${tr('네가 맞다고 보면 에이전트 편집 창의 역할 노트에 직접 써 넣어.')}` : why);
    }
    const body = checkText(cleanText(typeof text === 'string' ? text : ''));
    const now = Date.now();
    const item = {
      id: newId('note'), kind: KINDS.includes(kind) ? kind : 'method', text: body, source: src,
      status: src.type === 'user' ? 'confirmed' : 'draft', helped: 0, harmed: 0, localOnly: localOnly === true, createdAt: now, updatedAt: now,
    };
    const n = this.#read(agentId);
    n.items.push(item);
    this.#log(n, { op: 'add', itemId: item.id, after: { ...item, source: { ...src } } });
    this.#write(agentId, n);
    return n;
  }

  editItem(agentId, itemId, { text, kind, status } = {}) {
    const n = this.#read(agentId);
    const it = n.items.find((x) => x.id === itemId);
    if (!it) throw fail(404, tr('그 항목이 없어.'));
    const patch = {};
    if (text !== undefined) {
      // 에이전트·바깥 자료 항목은 사용자가 고칠 때도 같은 검사를 거친다(저장된 글에 그런 무늬가 남지 않게)
      if (it.source?.type !== 'user') { const why = suspicious(text); if (why) throw fail(400, why); }
      const body = checkText(cleanText(typeof text === 'string' ? text : ''));
      if (body !== it.text) patch.text = body;
    }
    if (kind !== undefined) { const k = KINDS.includes(kind) ? kind : 'method'; if (k !== it.kind) patch.kind = k; }
    if (status !== undefined) {
      if (!STATUSES.includes(status)) throw fail(400, tr('모르는 상태야: {status}', { status: String(status).slice(0, 20) }));
      if (status !== it.status) {
        const ways = MOVES[it.source?.type === 'user' ? 'user' : 'other'][it.status] || [];
        if (!ways.includes(status)) throw fail(400, tr('지금 상태({from})에서 {to}(으)로는 바꿀 수 없어.', { from: String(it.status).slice(0, 20), to: status }));
        patch.status = status;
      }
    }
    const keys = Object.keys(patch);
    if (!keys.length) return n;
    const before = Object.fromEntries(keys.map((k) => [k, it[k]]));
    Object.assign(it, patch, { updatedAt: Date.now() });
    this.#log(n, { op: keys.length === 1 && keys[0] === 'status' ? 'status' : 'edit', itemId: it.id, before, after: patch });
    this.#write(agentId, n);
    return n;
  }

  // 초안을 전부 받는다(확정). 기록 하나로 남아 한 번에 되돌린다
  acceptAll(agentId) {
    const n = this.#read(agentId);
    const ids = n.items.filter((x) => x.status === 'draft').map((x) => x.id);
    if (!ids.length) return n;
    const now = Date.now();
    for (const it of n.items) if (ids.includes(it.id)) { it.status = 'confirmed'; it.updatedAt = now; }
    this.#log(n, { op: 'acceptAll', before: { status: 'draft', ids }, after: { status: 'confirmed', ids } });
    this.#write(agentId, n);
    return n;
  }

  // 변경 하나를 되돌린다. 그 뒤에 같은 항목(하는 일 목록)이 또 바뀌었으면 되돌리지 않는다.
  // 추가를 되돌리면 지우지 않고 보관한다. 되돌림도 기록에 남아 다시 되돌릴 수 있다
  undo(agentId, logId) {
    const n = this.#read(agentId);
    const i = n.log.findIndex((x) => x.id === logId);
    if (i < 0) throw fail(404, tr('그 변경 기록이 없어.'));
    const e = n.log[i];
    const keys = touched(e);
    if (n.log.slice(i + 1).some((x) => touched(x).some((k) => keys.includes(k)))) {
      throw fail(409, tr('그 뒤에 같은 항목이 또 바뀌어서 되돌리지 않았어. 더 나중 변경부터 되돌려 줘.'));
    }
    const now = Date.now();
    let u;
    if (keys[0] === '#role') {
      const back = Array.isArray(e.before?.tasks) ? e.before.tasks : [];
      u = { before: { tasks: n.role.tasks }, after: { tasks: back } };
      n.role.tasks = back;
    } else if (Array.isArray(e.after?.ids)) {
      const ids = e.after.ids.filter((id) => n.items.some((x) => x.id === id));
      for (const it of n.items) if (ids.includes(it.id)) { it.status = e.before.status; it.updatedAt = now; }
      u = { before: { status: e.after.status, ids }, after: { status: e.before.status, ids } };
    } else {
      const it = n.items.find((x) => x.id === e.itemId);
      if (!it) throw fail(404, tr('그 항목이 없어.'));
      const target = e.before && typeof e.before === 'object' ? e.before : { status: 'archived' };
      u = { itemId: it.id, before: Object.fromEntries(Object.keys(target).map((k) => [k, it[k]])), after: { ...target } };
      Object.assign(it, target, { updatedAt: now });
    }
    this.#log(n, { op: 'undo', undoOf: e.id, ...u });
    this.#write(agentId, n);
    return n;
  }

  // 에이전트를 지우면 노트는 지우지 않고 <id>.removed.json 으로 이름만 바꾼다(이미 있으면 시각을 붙인다). 바꾼 경로, 노트가 없으면 null
  removeAgent(agentId) {
    const f = this.#file(agentId);
    if (!f || !fs.existsSync(f)) return null;
    let to = this.#file(agentId, '.removed');
    if (fs.existsSync(to)) to = this.#file(agentId, `.removed-${Date.now()}`);
    for (let i = 0; ; i++) {
      try { fs.renameSync(f, to); return to; } catch (e) {
        // 윈도우에서 백신·인덱서가 파일을 잡고 있으면 잠깐 실패할 수 있다(store.js writeAtomic 처럼 짧게 다시 해 본다)
        if (i >= 5) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      }
    }
  }
}

// 이번 실행의 시스템 지시에 넣을 항목 고르기(AI 호출 없음). 확정 항목만, 내 PC 모델 전용 항목은 받는 쪽이 내 PC 모델일 때만.
// 크기는 항목 글 + 프롬프트에 찍는 출처 주소(promptRef)의 글자 수로 센다.
// 글자 합이 limit 안이면 전부(최근에 고친 것 먼저). 넘으면 요청 글과 낱말이 겹치는 순 → helped − harmed 가 큰 순 → 최근 순으로 채운다.
// rules: 사용자 항목, refs: 에이전트·바깥 자료 항목(출처를 모르는 것도 여기), more: 넣지 못한 확정 항목 수(받을 수 없는 내 PC 전용 항목은 세지 않는다)
export function pickForPrompt(notes, requestText, { limit = PROMPT_LIMIT, receiverLocal = false } = {}) {
  const pool = (notes?.items || []).filter((x) => x && x.status === 'confirmed' && typeof x.text === 'string' && x.text && (!x.localOnly || receiverLocal));
  const recent = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  const sized = pool.map((x) => ({ x, n: chars(x.text) + chars(promptRef(x)) }));
  let picked;
  if (sized.reduce((s, r) => s + r.n, 0) <= limit) picked = pool.slice().sort(recent);
  else {
    const want = new Set(queryTerms(requestText));
    const score = (x) => { let k = 0; for (const w of new Set(tokenize(x.text))) if (want.has(w)) k++; return k; };
    const ranked = sized.map((r) => ({ ...r, s: score(r.x), w: (Number(r.x.helped) || 0) - (Number(r.x.harmed) || 0) }))
      .sort((a, b) => b.s - a.s || b.w - a.w || recent(a.x, b.x));
    picked = [];
    let used = 0;
    for (const r of ranked) if (used + r.n <= limit) { picked.push(r.x); used += r.n; }
  }
  return { rules: picked.filter((x) => x.source?.type === 'user'), refs: picked.filter((x) => x.source?.type !== 'user'), more: pool.length - picked.length };
}
