// 사용자가 올린 그림 값 정리: 래스터 data URL(PNG·JPEG·WEBP·GIF)만, 길이 상한까지만 저장한다
// (화면에서 256px 로 줄여 올리므로 보통 수십~백여 KB. 화면을 거치지 않은 큰 값으로 앱이 느려지는 걸 막는 용도)

export const MAX_IMAGE_CHARS = 600 * 1024;
const IMG_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export const isImageData = (v) => typeof v === 'string' && v.length <= MAX_IMAGE_CHARS && IMG_RE.test(v);

/** 에이전트 아바타: 알려진 종류만, 그림은 검사 통과한 것만(아니면 그림 필드를 뺀다) */
export function cleanAvatar(av) {
  if (!av || typeof av !== 'object' || Array.isArray(av)) return {};
  const out = { ...av };
  if (out.kind != null && !['person', 'creature', 'image'].includes(out.kind)) delete out.kind;
  if (out.image != null && !isImageData(out.image)) { delete out.image; delete out.pixel; }
  if (out.pixel != null) out.pixel = !!out.pixel;
  return out;
}

/** 스킨: 마을 커스텀이면 집 그림을 검사(통과 못 하면 기본 집), 다른 종류는 그대로 */
export function cleanSkin(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  if (s.type !== 'village') return s;
  const out = { ...s, base: 'village' };
  out.homeImage = isImageData(s.homeImage) ? s.homeImage : null;
  out.homePixel = !!(out.homeImage && s.homePixel);
  return out;
}
