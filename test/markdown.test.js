// 마크다운 렌더러: 에이전트 출력의 HTML·스크립트가 실행 가능한 태그로 나오면 안 된다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/js/markdown.js';

test('XSS: 태그·이벤트 속성·javascript 링크는 무력화', () => {
  const evil = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[클릭](javascript:alert(1))',
    '[x](https://ok.example/"onmouseover="alert(1))',
    // 링크 주소 안에 또 주소: 자동 링크가 이미 만든 href 속을 다시 바꾸면 따옴표가 깨져 on… 속성이 생겼다
    '[x](http://a(http://b/onmouseover=document.title=1//)',
    '[y](https://a.example/(https://b.example/onfocus=alert(1)/autofocus/)',
    '[z](https://x.example/**굵게**) 와 https://ok.example/**y**',
    '`<b>코드</b>`',
    '```\n<script>alert(2)</script>\n```',
    '> <iframe src="https://evil"></iframe>',
    '| a | b |\n|---|---|\n| <svg onload=alert(1)> | 2 |',
  ].join('\n\n');
  const out = renderMarkdown(evil);
  assert.ok(!/<script/i.test(out), 'script 태그');
  assert.ok(!/<img/i.test(out), 'img 태그');
  assert.ok(!/<iframe/i.test(out), 'iframe 태그');
  assert.ok(!/<svg/i.test(out), 'svg 태그');
  assert.ok(!/href="javascript:/i.test(out), 'javascript 링크');
  assert.ok(!/\son\w+="/i.test(out.replace(/&quot;/g, '')), '이벤트 속성');
  // 태그마다 속성을 뜯어 본다: a 태그의 속성은 href·target·rel 뿐이고, href 값 안에 태그나 따옴표가 없다
  const tags = out.match(/<a\b[^>]*>/g) || [];
  assert.ok(tags.length >= 4, `링크 ${tags.length}개`);
  for (const tag of tags) {
    assert.match(tag, /^<a href="[^"<>]*" target="_blank" rel="noopener noreferrer">$/, `링크 태그 모양: ${tag}`);
  }
  assert.ok(!/<a\b[^>]*<a\b/.test(out), '링크 안에 링크');
});

test('기본 문법: 제목·목록·표·코드·링크', () => {
  const out = renderMarkdown('# 제목\n\n- 하나\n- **둘**\n\n1. 첫째\n\n| 항목 | 값 |\n|---|---|\n| a | 1 |\n\n```js\nconst a = 1 < 2;\n```\n\n[구글](https://google.com) `code`');
  assert.match(out, /<h1>제목<\/h1>/);
  assert.match(out, /<ul><li>하나<\/li><li><strong>둘<\/strong><\/li><\/ul>/);
  assert.match(out, /<ol><li>첫째<\/li><\/ol>/);
  assert.match(out, /<table>.*<th>항목<\/th>.*<td>a<\/td>/);
  assert.match(out, /<code>const a = 1 &lt; 2;<\/code>/);
  assert.match(out, /<a href="https:\/\/google.com" target="_blank" rel="noopener noreferrer">구글<\/a>/);
  assert.match(out, /<code>code<\/code>/);
});
