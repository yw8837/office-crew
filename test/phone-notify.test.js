// 휴대폰 알림: 내 PC 안의 가짜 수신 서버로만 보낸다(외부 전송 0, 실제 AI 사용량 0)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp } from './helpers.js';
import { buildRequest, checkPhoneUrl } from '../server/notify.js';

let t;
let server;
let base;
let got = [];
let replyCode = 200;
before(async () => {
  t = await startTestApp();
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { got.push({ url: req.url, body: JSON.parse(body || '{}') }); res.statusCode = replyCode; res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); server.closeAllConnections?.(); try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });
beforeEach(() => { got = []; replyCode = 200; });

const setup = (type, path = '/hook-secret') => Object.assign(t.app.store.settings, { phoneNotify: true, phoneType: type, phoneUrl: `${base}${path}` });
const agent = async (name) => (await t.api('POST', '/api/agents', { name, role: '조사', provider: 'mock', permission: 'plan', routing: 'manual' })).json;
const run = async (a, text = '알림 시험') => {
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id, title: '비밀 세션 제목' })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 15000, '실행 끝');
  return s.id;
};

test('요청 모양: ntfy 는 주소에서 주제를 빼고 JSON, 웹훅은 흔한 서비스 필드까지', () => {
  const n = buildRequest('ntfy', 'https://ntfy.sh/my-topic', { title: '승인이 필요해', message: '세션' });
  assert.equal(n.url, 'https://ntfy.sh');
  assert.deepEqual(n.body, { topic: 'my-topic', title: '승인이 필요해', message: '세션' });
  assert.throws(() => buildRequest('ntfy', 'https://ntfy.sh/', { title: 'a', message: 'b' }), /주제/);
  const w = buildRequest('webhook', 'https://x.test/h', { title: 'T', message: 'M', status: 'done' });
  assert.equal(w.url, 'https://x.test/h');
  assert.deepEqual([w.body.title, w.body.status, w.body.text, w.body.content], ['T', 'done', 'T\nM', 'T\nM']);
  assert.throws(() => checkPhoneUrl('ftp://x'), /http/);
  assert.throws(() => checkPhoneUrl('아무말'), /형식/);
  assert.equal(checkPhoneUrl('  '), '');
});

test('기본은 꺼짐이고, 꺼져 있으면 아무것도 안 보낸다', async () => {
  assert.equal(t.app.store.settings.phoneNotify, false);
  t.app.store.settings.phoneUrl = `${base}/off`;
  await run(await agent('꺼짐담당'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(got.length, 0);
});

test('작업이 끝나면 한 번만 보내고, 대화 내용은 안 보낸다', async () => {
  setup('webhook');
  await run(await agent('끝담당'), '절대 밖으로 나가면 안 되는 내용');
  await t.waitFor(() => got.length >= 1, 3000, '수신');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(got.length, 1);
  assert.equal(got[0].url, '/hook-secret');
  assert.equal(got[0].body.title, '작업이 끝났어');
  assert.equal(got[0].body.status, 'done');
  assert.doesNotMatch(JSON.stringify(got[0].body), /절대 밖으로/);
});

test('승인을 기다리면 알리고, 같은 대기는 한 번만, 다시 기다리면 또 알린다', async () => {
  setup('ntfy', '/topicA');
  const team = t.app.store.all('teams').find((x) => x.stages.some((s) => s.approve));
  const s = (await t.api('POST', '/api/sessions', { teamId: team.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '승인 시험' });
  const waiting = () => got.filter((g) => g.body.title === '승인이 필요해').length;
  await t.waitFor(() => waiting() === 1, 20000, '첫 승인 알림');
  assert.equal(got.at(-1).body.topic, 'topicA');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'reject', text: '다시' });
  await t.waitFor(() => waiting() === 2, 20000, '다시 승인 알림');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 8000, '중지');
  assert.ok(!got.some((g) => g.body.title === '작업이 끝났어'), '멈춘 건 끝남으로 안 보낸다');
});

test('알림 서비스가 실패해도 작업은 정상으로 끝나고 오류를 남긴다. 오류 글에 주소가 없다', async () => {
  setup('webhook', '/hook-secret-token');
  replyCode = 500;
  const sid = await run(await agent('실패담당'));
  await t.waitFor(() => t.app.phone.lastError, 3000, '오류 기록');
  assert.equal(t.app.store.getSession(sid).runs.at(-1).status, 'done');
  assert.match(t.app.phone.lastError, /500/);
  assert.doesNotMatch(t.app.phone.lastError, /secret/);
});

test('API: 주소는 가려서 주고, 가린 값을 다시 보내면 그대로 유지, 형식 오류는 거부', async () => {
  const secret = `${base}/token-abcdefgh1234`;
  const s = (await t.api('PUT', '/api/settings', { phoneUrl: secret, phoneType: 'webhook', phoneNotify: true })).json;
  assert.ok(!s.phoneUrl.includes('token-abcd'), s.phoneUrl);
  await t.api('PUT', '/api/settings', { phoneUrl: s.phoneUrl });
  assert.equal(t.app.store.settings.phoneUrl, secret);
  assert.equal((await t.api('PUT', '/api/settings', { phoneUrl: 'ftp://nope' })).status, 400);
  const bootstrap = (await t.api('GET', '/api/bootstrap')).json;
  assert.ok(!JSON.stringify(bootstrap.settings).includes('token-abcd'));
});

test('시험 보내기: 눌렀을 때만 보내고 실패는 알려 준다', async () => {
  setup('webhook', '/test-send');
  assert.equal((await t.api('POST', '/api/phone/test', {})).status, 200);
  assert.equal(got.length, 1);
  assert.equal(got[0].url, '/test-send');
  replyCode = 503;
  const r = await t.api('POST', '/api/phone/test', {});
  assert.equal(r.status, 502);
  assert.match(r.json.error, /503/);
  t.app.store.settings.phoneUrl = '';
  assert.equal((await t.api('POST', '/api/phone/test', {})).status, 400);
});
