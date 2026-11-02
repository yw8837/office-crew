import { normLang } from './i18n.js';

// 내장 스킨 3종(팔레트 + 소품 변형). custom 스킨은 { type:'image', image, width, height, desks, spots }

const BOOKS_BRIGHT = ['#d9534f', '#4f81bd', '#8cbf4f', '#f0a04b', '#8064a2', '#3fb2c9', '#e0b93a', '#5e8c3a', '#c76b98', '#6d7b8d'];

export const SKINS = [
  {
    id: 'modern',
    name: '모던 오피스',
    names: { ko: '모던 오피스', en: 'Modern Office', zh: '现代办公室', ja: 'モダンオフィス' },
    type: 'vector',
    palette: {
      bg: '#eef2f7', bg2: '#dfe6ef',
      floor: '#ead9bf', floorAlt: '#e3cfb2', floorLine: '#cfb894', slab: '#d4bf9c', slabDark: '#b9a079',
      tile: '#e6e9ee', tileLine: '#c9cfd8',
      wall: '#f8f6f2', wallLow: '#f8f6f2', wallTop: '#ffffff', wallEnd: '#ddd7cd', base: '#d3cabb',
      desktop: '#dcb88d', deskBody: '#f2f0eb', cabinet: '#e9e6df',
      wood: '#cfa676', woodDark: '#a87c52',
      chair: '#3c4350', chairFrame: '#262b33',
      sofa: '#7f9cc4', sofaDark: '#647fa6', rug: '#d8e2ec', rug2: '#c3d1df', meetRug: '#cfd9e4',
      plant: '#5fae5a', plantDark: '#3e8a45', plantLight: '#93d172', pot: '#f4f2ee',
      metal: '#a7afba', dark: '#3a414d',
      sky1: '#8ccaf6', sky2: '#e6f5ff', city: '#bcd0e4', city2: '#a3bcd5', cityLight: '#fff7cf', cloud: '#ffffff',
      screen: '#1d2430', screenIdle: '#3c5d8f', glow: '#86c9ff',
      server: '#2b303b', serverFace: '#363d4b',
      board: '#ffffff', frame: '#c9c2b6',
      label: '#ffffff', labelText: '#2b3240', labelLine: '#e4e0d8',
      light: '#fffbe9', lightOp: 0.32,
      books: BOOKS_BRIGHT,
      accent: '#4c8dff',
    },
    props: { sky: 'day', wainscot: false, neon: false, cat: false, lamps: false, glow: false, plants: 1 },
  },
  {
    id: 'cozy',
    name: '코지 우드',
    names: { ko: '코지 우드', en: 'Cozy Wood', zh: '温馨木屋', ja: 'コージーウッド' },
    type: 'vector',
    palette: {
      bg: '#f6e7d2', bg2: '#ecd3b3',
      floor: '#cf8f50', floorAlt: '#c48344', floorLine: '#a8682f', slab: '#a8662f', slabDark: '#86501f',
      tile: '#d9cdbd', tileLine: '#b9a993',
      wall: '#f4e6cf', wallLow: '#b98451', wallTop: '#fff6e6', wallEnd: '#d9c3a3', base: '#7e5129',
      desktop: '#a86a3a', deskBody: '#8b5530', cabinet: '#9a6136',
      wood: '#9a6136', woodDark: '#6f4120',
      chair: '#2f3f6b', chairFrame: '#1d2744',
      sofa: '#7d3a6d', sofaDark: '#5f2953', rug: '#743065', rug2: '#8f4380', meetRug: '#6e2d5f',
      plant: '#4f9d43', plantDark: '#2f7a34', plantLight: '#80c75d', pot: '#e4dccf',
      metal: '#b3a99a', dark: '#3b3029',
      sky1: '#ff9f5e', sky2: '#ffe0a8', city: '#c98b7c', city2: '#b07466', cityLight: '#ffe7a3', cloud: '#ffd2b0',
      screen: '#1f2430', screenIdle: '#5d6fa8', glow: '#ffd79a',
      server: '#2d2a2e', serverFace: '#3b3640',
      board: '#fffaf0', frame: '#8b5a30',
      label: '#fffaf1', labelText: '#4a3423', labelLine: '#ead8bf',
      light: '#ffd9a0', lightOp: 0.26,
      books: ['#b5523b', '#3f6e9c', '#6f9a3e', '#d9913f', '#7a4f8f', '#c9a237', '#8f3b3b', '#4e7f6f', '#a86b4a'],
      accent: '#e07a3f',
    },
    props: { sky: 'sunset', wainscot: true, neon: false, cat: true, lamps: true, glow: false, plants: 2 },
  },
  {
    id: 'night',
    name: '나이트 시티',
    names: { ko: '나이트 시티', en: 'Night City', zh: '夜色都市', ja: 'ナイトシティ' },
    type: 'vector',
    palette: {
      bg: '#0b1020', bg2: '#141b33',
      floor: '#252e49', floorAlt: '#222a43', floorLine: '#1a2137', slab: '#171d31', slabDark: '#10152a',
      tile: '#1f2742', tileLine: '#2d3a63',
      wall: '#28314f', wallLow: '#232b47', wallTop: '#3a4672', wallEnd: '#1d2440', base: '#151b30',
      desktop: '#3a4670', deskBody: '#2b3456', cabinet: '#2f3a5f',
      wood: '#3b4672', woodDark: '#262f50',
      chair: '#141a2c', chairFrame: '#0c101c',
      sofa: '#3d2f70', sofaDark: '#2c2154', rug: '#271f4f', rug2: '#33296a', meetRug: '#1e2747',
      plant: '#2f8f74', plantDark: '#1e6a58', plantLight: '#47b493', pot: '#3a4466',
      metal: '#5d6890', dark: '#11162a',
      sky1: '#070b22', sky2: '#1f2a5a', city: '#121a36', city2: '#0d1430', cityLight: '#ffd36b', cloud: '#2a3466',
      screen: '#0a0f1e', screenIdle: '#1e3a7a', glow: '#3df5ff',
      server: '#121726', serverFace: '#1a2135',
      board: '#e9eef8', frame: '#4a5682',
      label: '#141b33', labelText: '#d9f6ff', labelLine: '#3df5ff',
      light: '#7fa9ff', lightOp: 0.10,
      books: ['#3df5ff', '#ff4fd8', '#7c6cff', '#3b82f6', '#22c55e', '#f59e0b', '#64748b', '#a855f7'],
      accent: '#3df5ff', neon2: '#ff4fd8',
    },
    props: { sky: 'night', wainscot: false, neon: true, cat: false, lamps: true, glow: true, plants: 1 },
  },
];

/** 스킨 이름(언어별). 내장 스킨은 names[lang], 커스텀은 사용자가 붙인 name */
export function skinName(s, lang) {
  const skin = typeof s === 'string' ? SKINS.find((k) => k.id === s) : s;
  if (!skin) return '';
  const l = normLang(lang);
  return (skin.names && (skin.names[l] || skin.names.en)) || skin.name || skin.id || '';
}

/** 스킨 id 또는 객체 → 스킨 객체 */
export function resolveSkin(s) {
  if (!s) return SKINS[0];
  if (typeof s === 'string') return SKINS.find((k) => k.id === s) || SKINS[0];
  if (s.type === 'image' && s.image) return s;
  if (s.palette) {
    // 내장 스킨 기반 부분 덮어쓰기 허용: { base:'modern', palette:{...} }
    const base = SKINS.find((k) => k.id === s.base) || SKINS[0];
    return { ...base, ...s, palette: { ...base.palette, ...s.palette }, props: { ...base.props, ...(s.props || {}) } };
  }
  return SKINS[0];
}
