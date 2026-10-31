import { test } from 'node:test';
import assert from 'node:assert/strict';

const { hasHeader, readJsonBody, sendJson, HttpError } = await import('../dist/http.js');

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
