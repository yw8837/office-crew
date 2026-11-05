// 크루 마을 스킨·아바타 종류: 사용자가 올린 그림은 래스터(data:image/png 등)만 받고, 기본 스킨은 마을
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKINS, resolveSkin, skinName } from '../public/js/office/skins.js';
import { avatarKind, renderAvatarSVG } from '../public/js/office/character.js';
import { defaultSettings } from '../server/seed.js';
import { cleanAvatar, cleanSkin, isImageData, MAX_IMAGE_CHARS } from '../server/media.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+';

test('기본 스킨은 크루 마을이고 4개 언어 이름이 있다', () => {
  assert.equal(SKINS[0].id, 'village');
  assert.equal(resolveSkin().type, 'village');
  assert.equal(resolveSkin('village').type, 'village');
  assert.equal(resolveSkin('없는-스킨').id, 'village');
  for (const l of ['ko', 'en', 'zh', 'ja']) assert.ok(skinName('village', l));
  assert.equal(resolveSkin('modern').id, 'modern'); // 기존 사무실 스킨도 그대로 고를 수 있다
});

test('새로 설치하면 설정의 스킨이 마을이다', () => {
  assert.equal(defaultSettings().skin, 'village');
});

test('커스텀 마을: 집 그림은 래스터만 받고 SVG 는 버린다', () => {
  const ok = resolveSkin({ id: 'my', name: '내 마을', type: 'village', homeImage: PNG, homePixel: true });
  assert.equal(ok.type, 'village');
  assert.equal(ok.homeImage, PNG);
  assert.ok(ok.palette.grass, '마을 팔레트를 물려받는다');
  const bad = resolveSkin({ id: 'x', type: 'village', homeImage: SVG });
  assert.equal(bad.homeImage, null);
  const junk = resolveSkin({ id: 'y', type: 'village', homeImage: 'javascript:alert(1)' });
  assert.equal(junk.homeImage, null);
});

test('팔레트만 덮어쓴 스킨은 예전처럼 모던 사무실을 바탕으로 한다(마을이 섞이지 않음)', () => {
  const s = resolveSkin({ id: 'p', base: '없는-id', palette: { floor: '#123456' } });
  assert.equal(s.type, 'vector');
  assert.equal(s.palette.floor, '#123456');
  assert.equal(s.palette.wall, resolveSkin('modern').palette.wall);
  assert.equal(resolveSkin({ id: 'q', base: 'village', palette: {} }).type, 'vector');
});

test('서버: 아바타·마을 스킨 그림은 래스터 data URL·길이 상한만 저장', () => {
  assert.deepEqual(cleanAvatar(null), {});
  assert.deepEqual(cleanAvatar([1]), {});
  const ok = cleanAvatar({ kind: 'image', image: PNG, pixel: 1, hair: '#000' });
  assert.equal(ok.image, PNG); assert.equal(ok.pixel, true); assert.equal(ok.hair, '#000');
  const svg = cleanAvatar({ kind: 'image', image: SVG, pixel: true });
  assert.equal(svg.image, undefined); assert.equal(svg.pixel, undefined); assert.equal(svg.kind, 'image');
  assert.equal(cleanAvatar({ kind: 'robot' }).kind, undefined);
  const big = 'data:image/png;base64,' + 'A'.repeat(MAX_IMAGE_CHARS);
  assert.equal(cleanAvatar({ kind: 'image', image: big }).image, undefined);
  assert.equal(isImageData(PNG), true);
  const v = cleanSkin({ type: 'village', name: '내 마을', homeImage: SVG, homePixel: true, base: 'modern' });
  assert.equal(v.homeImage, null); assert.equal(v.homePixel, false); assert.equal(v.base, 'village');
  assert.equal(cleanSkin({ type: 'village', homeImage: PNG, homePixel: true }).homePixel, true);
  const img = { type: 'image', image: 'data:image/webp;base64,AAAA', desks: [] };
  assert.equal(cleanSkin(img), img); // 이미지 스킨(평면도)은 기존 그대로
});

test('아바타 종류: 사람(기본)·크리처·이미지, 이미지는 래스터만', () => {
  assert.equal(avatarKind(undefined), 'person');
  assert.equal(avatarKind({ hair: '#000' }), 'person');
  assert.equal(avatarKind({ kind: 'creature' }), 'creature');
  assert.equal(avatarKind({ kind: 'image', image: PNG }), 'image');
  assert.equal(avatarKind({ kind: 'image', image: SVG }), 'person');
  assert.equal(avatarKind({ kind: 'image' }), 'person'); // 그림을 아직 안 올렸으면 사람으로
});

test('미리보기 SVG: 크리처는 기본 표정 하나만, 이미지는 도트 그림이면 선명하게', () => {
  const cr = renderAvatarSVG({ kind: 'creature', outfit: '#3b82f6', species: 'ears' }, { size: 40, id: 'a' });
  assert.match(cr, /^<svg /);
  assert.ok(!cr.includes('ex-wide') && !cr.includes('mo-grin'), '상태별 표정 레이어는 미리보기에 넣지 않는다');
  const im = renderAvatarSVG({ kind: 'image', image: PNG, pixel: true }, { size: 40 });
  assert.ok(im.includes('<image') && im.includes('image-rendering:pixelated'));
  const fallback = renderAvatarSVG({ kind: 'image', image: SVG }, { size: 40, id: 'b' });
  assert.ok(!fallback.includes('svg+xml'), 'SVG 그림은 그리지 않고 사람 아바타로 대신한다');
});
