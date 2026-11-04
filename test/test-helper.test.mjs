/**
 * 测试辅助（./test 子路径）自身的用例：断言它们复现 cordis 的真实语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createAbsentContext, createUndeclaredContext, applyWithoutThrowing } = await import('../dist/test.js');

test('createAbsentContext：读任意服务返回 undefined，不抛', () => {
  const ctx = createAbsentContext();
  assert.equal(ctx.webServer, undefined);
  assert.equal(ctx.pluginManager, undefined);
  assert.equal(typeof ctx.inject, 'function');
});

test('createUndeclaredContext：读未声明属性 → 抛 cannot get property without inject', () => {
  const ctx = createUndeclaredContext();
  // 已声明的面正常存在
  assert.equal(typeof ctx.inject, 'function');
  assert.equal(typeof ctx.logger, 'function');
  // 未声明的服务读取按 cordis 语义抛错
  assert.throws(() => ctx.webServer, /cannot get property "webServer" without inject/);
  assert.throws(() => ctx.pluginManager, /cannot get property "pluginManager" without inject/);
});

test('createUndeclaredContext：symbol 键与已声明键不抛', () => {
  const ctx = createUndeclaredContext();
  assert.doesNotThrow(() => ctx[Symbol.iterator]);
  assert.doesNotThrow(() => ctx.get);
  assert.doesNotThrow(() => ctx.set);
});

test('createUndeclaredContext：inject 回调不抛、返回 disposer', () => {
  const ctx = createUndeclaredContext();
  assert.doesNotThrow(() => {
    const dispose = ctx.inject(['webServer'], () => {});
    assert.equal(typeof dispose, 'function');
  });
});

test('applyWithoutThrowing：apply 里读未声明服务 → 抛（复现红点事故）', () => {
  const entry = {
    apply(ctx) {
      // 一行没保护的读取
      ctx.webServer.register({});
    },
  };
  assert.throws(() => applyWithoutThrowing(entry), /without inject/);
});

test('applyWithoutThrowing：apply 用 inject 延迟读取 → 不抛', () => {
  const entry = {
    apply(ctx) {
      ctx.inject(['webServer'], (serviceCtx) => {
        // 回调在服务就绪后执行；测试辅助不触发它，故这里不应被调用
        void serviceCtx.webServer;
      });
    },
  };
  assert.doesNotThrow(() => applyWithoutThrowing(entry));
});

test('applyWithoutThrowing：entry 没有 apply → 明确报错', () => {
  assert.throws(() => applyWithoutThrowing({}), /entry\.apply is not a function/);
});
