// 서버 다국어: 화면과 같은 사전(public/js/i18n)을 써서 오류·알림·에이전트 지침을 설정 언어로 바꾼다
import en from '../public/js/i18n/en.js';
import zh from '../public/js/i18n/zh.js';
import ja from '../public/js/i18n/ja.js';

const DICTS = { en, zh, ja };
let getLang = () => 'ko';

// 설정 언어를 읽는 함수를 등록(비어 있으면 OS 언어)
export function bindLang(fn) { getLang = fn; }

export function serverLang() {
  const l = String(getLang() || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || 'ko').toLowerCase();
  return l.startsWith('ko') ? 'ko' : l.startsWith('zh') ? 'zh' : l.startsWith('ja') ? 'ja' : 'en';
}

export function tr(ko, vars) {
  const lang = serverLang();
  let s = (lang !== 'ko' && DICTS[lang]?.[ko]) || ko;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}
