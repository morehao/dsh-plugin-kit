import { test } from 'node:test';
import assert from 'node:assert/strict';

const { hasHeader, readJsonBody, sendJson, HttpError, createRouteHandler } = await import('../dist/http.js');

function fakeFullResponse() {
  const captured = { status: 0, headers: {}, body: '', writableEnded: false };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body = '') {
      captured.body = body;
      captured.writableEnded = true;
    },
  };
}

async function* bodyChunks(values) {
  for (const value of values) yield value;
}

function fakeRequest({ url = '/', method = 'GET', headers = {}, body = [] } = {}) {
  return Object.assign(bodyChunks(body), { url, method, headers });
}

function fakeResponse() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body = '') {
      captured.body = body;
    },
  };
}

test('鉴权头精确匹配', () => {
  assert.equal(hasHeader({ headers: { 'x-demo': '1' } }, 'x-demo'), true);
  assert.equal(hasHeader({ headers: { 'x-demo': '0' } }, 'x-demo'), false);
  assert.equal(hasHeader({ headers: {} }, 'x-demo'), false);
  assert.equal(hasHeader({}, 'x-demo'), false);
});

test('sendJson：no-store + 正确 content-length', () => {
  const response = fakeResponse();
  sendJson(response, 200, { ok: true });
  assert.equal(response.captured.status, 200);
  assert.equal(response.captured.headers['cache-control'], 'no-store');
  assert.equal(response.captured.body, '{"ok":true}');
  assert.equal(response.captured.headers['content-length'], Buffer.byteLength('{"ok":true}'));
});

test('readJsonBody：解析 / 空 body / 超限 / 非法', async () => {
  async function* chunks(values) {
    for (const value of values) yield value;
  }
  assert.deepEqual(await readJsonBody(chunks(['{"a":1}'])), { a: 1 });
  assert.deepEqual(await readJsonBody(chunks([])), {});
  await assert.rejects(readJsonBody(chunks(['{"a":1}']), { maxBytes: 2 }), (error) => error instanceof HttpError && error.code === 'PAYLOAD_TOO_LARGE');
  await assert.rejects(readJsonBody(chunks(['{oops'])), (error) => error instanceof HttpError && error.code === 'INVALID_JSON');
  await assert.rejects(readJsonBody(chunks(['[1]'])), (error) => error instanceof HttpError && error.code === 'INVALID_JSON');
});

test('createRouteHandler：鉴权头不符 → 403', async () => {
  const handler = createRouteHandler({ prefix: '/api/x', header: 'x-demo', dispatch: async () => ({}) });
  const response = fakeFullResponse();
  await handler(fakeRequest({ url: '/api/x/state', headers: {} }), response);
  assert.equal(response.captured.status, 403);
});

test('createRouteHandler：正常 dispatch 包成 {ok:true,...}，剥 prefix', async () => {
  let seen;
  const handler = createRouteHandler({
    prefix: '/api/x',
    header: 'x-demo',
    dispatch: async (ctx) => {
      seen = ctx;
      return { value: 42 };
    },
  });
  const response = fakeFullResponse();
  await handler(fakeRequest({ url: '/api/x/state?a=1', method: 'GET', headers: { 'x-demo': '1' } }), response);
  assert.equal(seen.pathname, '/state');
  assert.equal(seen.method, 'GET');
  assert.equal(response.captured.status, 200);
  assert.equal(response.captured.body, '{"ok":true,"value":42}');
});

test('createRouteHandler：POST 解析 body 传给 dispatch', async () => {
  let body;
  const handler = createRouteHandler({
    prefix: '/api/x',
    header: 'x-demo',
    dispatch: async (ctx) => {
      body = ctx.body;
      return {};
    },
  });
  const response = fakeFullResponse();
  await handler(fakeRequest({ url: '/api/x/save', method: 'POST', headers: { 'x-demo': '1' }, body: ['{"a":1}'] }), response);
  assert.deepEqual(body, { a: 1 });
});

test('createRouteHandler：body 超限 → HttpError 抛出路径（默认 500）', async () => {
  const handler = createRouteHandler({ prefix: '/api/x', header: 'x-demo', maxBodyBytes: 2, dispatch: async () => ({}) });
  const response = fakeFullResponse();
  await handler(fakeRequest({ url: '/api/x/s', method: 'POST', headers: { 'x-demo': '1' }, body: ['{"a":1}'] }), response);
  assert.equal(response.captured.status, 500);
  assert.equal(JSON.parse(response.captured.body).code, 'INTERNAL');
});

test('createRouteHandler：业务抛错经 onError 映射', async () => {
  const handler = createRouteHandler({
    prefix: '/api/x',
    header: 'x-demo',
    dispatch: async () => {
      throw Object.assign(new Error('boom'), { code: 'MY_CODE' });
    },
    onError: (error) => ({ status: 409, code: error.code, message: error.message, extra: { detail: 'x' } }),
  });
  const response = fakeFullResponse();
  await handler(fakeRequest({ url: '/api/x/s', headers: { 'x-demo': '1' } }), response);
  assert.equal(response.captured.status, 409);
  const parsed = JSON.parse(response.captured.body);
  assert.equal(parsed.code, 'MY_CODE');
  assert.equal(parsed.detail, 'x');
});

test('createRouteHandler：dispatch 返回 undefined → 只回 {ok:true}', async () => {
  const handler = createRouteHandler({
    prefix: '/api/x',
    header: 'x-demo',
    dispatch: async () => undefined,
  });
  const response = fakeFullResponse();
  await handler(fakeRequest({ url: '/api/x/s', headers: { 'x-demo': '1' } }), response);
  assert.equal(response.captured.status, 200);
  assert.equal(response.captured.body, '{"ok":true}');
});
