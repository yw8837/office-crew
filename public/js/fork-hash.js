// 두 갈래 카드(결정 0031)의 "본 것" 해시: 화면(views/mission.js 의 ForkCard)과 서버(server/mission.js 의 forkHash)가 같은 글로 같은 값을 만든다.
// 글은 안마다 [키, 입장, 요약] 그대로(JSON). 화면은 그린 카드의 값으로 만들고, 서버는 저장된 카드로 다시 만들어 대조한다(다르면 반영하지 않는다)
export const forkText = (options = []) => JSON.stringify((options || []).map((o) => [o.key, o.position, o.summary || '']));

// SHA-256 16진수. 브라우저(안전한 주소)와 Node.js 20 이상의 Web Crypto 로 같은 값이 나온다. 쓸 수 없으면 던진다(화면은 카드에 실린 값으로 대신한다)
export async function forkDigest(options = []) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(forkText(options)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
