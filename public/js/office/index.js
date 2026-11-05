// 사무실 렌더러 진입점(ES 모듈, 의존성 없음)
//   createOffice(container, { skin, reducedMotion, onSelect }) -> office
//   createOffice 옵션 lang('ko'|'en'|'zh'|'ja'), quality('full'|'lite'|'static') / office.setLanguage(lang), office.setQuality(q)
//   SKINS, skinName(skin, lang), createSkinEditor(container, { skin, onSave, onCancel, lang }), renderAvatarSVG(avatar, { size, color, id })
export { createOffice, toolIcon } from './office.js';
export { SKINS, resolveSkin, skinName } from './skins.js';
export { LANGS, normLang } from './i18n.js';
export { createSkinEditor } from './editor.js';
export { renderAvatarSVG, avatarKind, HAIR_STYLES, ACCESSORIES, OUTFITS } from './character.js';
