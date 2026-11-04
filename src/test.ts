/**
 * 测试辅助：模拟 cordis 上下文，供消费插件断言 `apply()` 在服务缺失 / 未声明时不抛。
 *
 * 为什么进 kit：`dsh-commands` / `dsh-github-trending` / `dsh-skills-console` 都在各自
 * `apply()` 里读宿主服务（`ctx.webServer` / `pluginManager` / `profileContext` …）。cordis 的
 * 语义是「读一个未声明 inject 的属性不是返回 undefined，而是抛 `cannot get property "..."
 * without inject`」——一行没保护的读取会让整行 apply 失败、插件管理器只显示一个红点、没有任何
 * 文字。三个插件都要为这条事故写同一份守卫测试，故沉淀到这里，免各写一份 Proxy。
 *
 * 设计取舍：
 * - **纯 headless**：不 import node 内置、不引 React，host / 客户端测试均可用。
 * - **只模拟 apply 真正会碰的面**：`inject / on / effect / get / set / provide / logger / reflect`；
 *   需要别的服务时，缺的键会按 cordis 语义自己抛错（这正是要测的）。
 * - **类型宽松**：`TestContext` 用结构化类型，不引 `@deepseek-ai/*`（守住零宿主依赖铁律）。
 *
 * 只用于测试，不进运行时主链。
 */

/** apply() 会用到的最小上下文面；`[key: string]: unknown` 让未声明读取落入 Proxy 抛错分支。 */
export interface TestContext {
  inject: (deps: string[], callback: (ctx: TestContext) => void) => () => void;
  on: (...args: unknown[]) => () => void;
  effect: (...args: unknown[]) => () => void;
  get: (name: string) => unknown;
  set: (name: string, value: unknown) => void;
  provide: (...args: unknown[]) => () => void;
  logger: (...args: unknown[]) => void;
  reflect: { get: (name: string) => unknown; set: (name: string, value: unknown) => void; provide: (...args: unknown[]) => () => void };
  [key: string]: unknown;
}

const noop = () => () => {};

function baseContext(): Record<string, unknown> {
  return {
    inject: (_deps: string[], _callback: (ctx: TestContext) => void) => () => {},
    on: noop,
    effect: noop,
    logger: () => {},
    get: () => undefined,
    set: () => {},
    provide: noop,
    reflect: { get: () => undefined, set: () => {}, provide: noop },
  };
}

/**
 * 一个「服务尚未挂载」的上下文：读任意服务返回 `undefined`，不抛。
 * 用来验证 apply() 在服务缺失时**降级**而不是炸掉。
 */
export function createAbsentContext(): TestContext {
  return baseContext() as TestContext;
}

/**
 * 一个执行 cordis 规则的上下文：读任何**未声明**的属性直接抛
 * `cannot get property "<key>" without inject`。
 *
 * 用它跑 `apply()`，若插件读了没声明的服务，就会在测试里复现真实宿主那条
 * 「红点无面板」的失败路径。
 */
export function createUndeclaredContext(): TestContext {
  const base = baseContext();
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key in target) return Reflect.get(target, key, receiver);
      if (typeof key === 'symbol') return undefined;
      throw new Error(`cannot get property "${String(key)}" without inject`);
    },
  }) as TestContext;
}

/**
 * 便捷断言：`entry.apply(ctx)` 不该抛。
 *
 * `entry` 是插件的宿主入口模块（需要有 `apply` 函数）；`ctx` 默认用
 * `createUndeclaredContext()`（最严：连未声明的服务读取都不许）。测试辅助不直接
 * import 断言库，抛错由调用侧（node:test / 任意框架）自然失败。
 */
export function applyWithoutThrowing(
  entry: { apply?: (...args: unknown[]) => unknown },
  ctx: TestContext = createUndeclaredContext(),
): void {
  if (typeof entry.apply !== 'function') {
    throw new Error('entry.apply is not a function');
  }
  entry.apply(ctx);
}
