// 화면 다국어: 원문(한국어)을 키로 쓰고, 언어별 사전에 없으면 원문을 그대로 보여준다
// 사용: t('새 세션'), t('{name}에게 보내기', { name })
import en from './en.js';
import zh from './zh.js';
import ja from './ja.js';

export const LANGS = [['ko', '한국어'], ['en', 'English'], ['zh', '中文'], ['ja', '日本語']];
const DICTS = { en, zh, ja };
let lang = 'ko';

export function normLang(l = '') {
  const s = String(l).toLowerCase();
  return s.startsWith('ko') ? 'ko' : s.startsWith('zh') ? 'zh' : s.startsWith('ja') ? 'ja' : 'en';
}

export function setLang(l) {
  lang = normLang(l);
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
}
export const getLang = () => lang;

export function t(ko, vars) {
  let s = (lang !== 'ko' && DICTS[lang]?.[ko]) || ko;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}

// 날짜·시간 표시용 로캘(현재 언어)
export const locale = () => ({ ko: 'ko-KR', zh: 'zh-CN', ja: 'ja-JP' }[lang] || 'en-US');

// 모듈 상수 라벨 맵: 읽을 때마다 현재 언어로 다시 만든다(언어를 바꾸면 바로 반영). 사용: tmap(() => ({ idle: t('대기') }))
export function tmap(make) {
  return new Proxy({}, {
    get: (_, k) => make()[k],
    has: (_, k) => k in make(),
    ownKeys: () => Reflect.ownKeys(make()),
    getOwnPropertyDescriptor: (_, k) => Object.getOwnPropertyDescriptor(make(), k),
  });
}
