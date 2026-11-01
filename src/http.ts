/**
 * HTTP 小工具：三个 web 插件共用的「自定义头鉴权 + no-store JSON + 有上限的 JSON body」。
 *
 * 只依赖结构化形状（不 import node:http 类型），宿主的 request/response 直接可用；
 * 鉴权头名称由调用方给，避免把某一个插件的约定强加给其他插件。
 */
export interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
}

export interface ResponseLike {
  writeHead(status: number, headers: Record<string, string | number>): unknown;
  end(body?: string): unknown;
}

export type HttpErrorCode = 'PAYLOAD_TOO_LARGE' | 'INVALID_JSON';

export class HttpError extends Error {
  readonly code: HttpErrorCode;

  constructor(code: HttpErrorCode, message: string) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
  }
}

/** 请求头精确等于 `value`（默认 `1`）才算通过：跨源请求要先过预检，顺带挡 CSRF。 */
export function hasHeader(request: RequestLike, header: string, value = '1'): boolean {
  return request.headers?.[header.toLowerCase()] === value;
}

export function sendJson(response: ResponseLike, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

export interface ReadJsonOptions {
  maxBytes?: number;
}

/** 读一个 JSON 对象 body；超过上限抛 PAYLOAD_TOO_LARGE，非对象/非法 JSON 抛 INVALID_JSON。 */
export async function readJsonBody(
  request: AsyncIterable<Uint8Array | string>,
  options: ReadJsonOptions = {},
): Promise<Record<string, unknown>> {
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError('PAYLOAD_TOO_LARGE', '请求体过大');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new HttpError('INVALID_JSON', `请求体不是 JSON 对象：${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError('INVALID_JSON', '请求体不是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

// ── 薄路由 dispatcher ────────────────────────────────────────────────
//
// 只做「鉴权 → 剥前缀 → 读 body → 调业务 → 包 {ok:true} → 错误兜底」这层样板，
// **不做**路由表 DSL / 参数解析 / 错误码翻译：各插件的 matchRoute 与错误码体系差异大，
// 保留在 `dispatch` 与 `onError` 里（能复用就复用，业务别硬塞）。

export interface RouteContext {
  request: RequestLike & AsyncIterable<Uint8Array | string>;
  url: URL;
  /** 大写方法名。 */
  method: string;
  /** 已剥掉 prefix 的 pathname（`/state` 之类）。 */
  pathname: string;
  /** 已解析的 JSON body（超出上限/非法会先抛 HttpError）；无 body 时空对象。 */
  body: Record<string, unknown>;
}

/** 把插件自己的错误（IpcError / ServiceError …）映射成 HTTP 响应；返回 undefined 走默认 500。 */
export type RouteErrorMapper = (
  error: unknown,
) => { status: number; code?: string; message: string; extra?: Record<string, unknown> } | undefined;

export interface CreateRouteHandlerOptions {
  /** 路由前缀，如 `/api/morehao/xxx`。 */
  prefix: string;
  /** 鉴权头名；要求值 `1`（跨源预检顺带挡 CSRF）。 */
  header: string;
  /** 业务 dispatch：返回结果对象（包成 `{ok:true,...}`）或自行写完响应（返回 void）。 */
  dispatch: (ctx: RouteContext) => Promise<Record<string, unknown> | void>;
  /** body 上限；默认 512 KiB。 */
  maxBodyBytes?: number;
  /** 错误映射；缺省 500 INTERNAL。 */
  onError?: RouteErrorMapper;
  logger?: (event: string, data?: Record<string, unknown>) => void;
}

export type RouteHandler = (request: unknown, response: unknown) => Promise<void>;

/** 造一个宿主的 request 处理器：统一鉴权 / body / 响应 / 错误兜底。 */
export function createRouteHandler(options: CreateRouteHandlerOptions): RouteHandler {
  const maxBodyBytes = options.maxBodyBytes ?? 512 * 1024;
  const logger = options.logger ?? (() => {});
  const prefix = options.prefix;

  return async (rawRequest: unknown, rawResponse: unknown): Promise<void> => {
    const request = rawRequest as RequestLike & AsyncIterable<Uint8Array | string> & { url?: string; method?: string };
    const response = rawResponse as ResponseLike & { writableEnded?: boolean };

    if (!hasHeader(request, options.header)) {
      sendJson(response, 403, { ok: false, code: 'FORBIDDEN', message: `缺少 ${options.header}: 1 头` });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : url.pathname;
    const method = (request.method ?? 'GET').toUpperCase();

    try {
      const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(request, { maxBytes: maxBodyBytes });
      const result = await options.dispatch({ request, url, method, pathname, body });
      if (response.writableEnded !== true) {
        sendJson(response, 200, result === undefined ? { ok: true } : { ok: true, ...result });
      }
    } catch (error) {
      if (response.writableEnded === true) return;
      const mapped = options.onError?.(error);
      if (mapped !== undefined) {
        sendJson(response, mapped.status, {
          ok: false,
          ...(mapped.code === undefined ? {} : { code: mapped.code }),
          message: mapped.message,
          ...(mapped.extra === undefined ? {} : mapped.extra),
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger('route.error', { method, pathname, message });
      sendJson(response, 500, { ok: false, code: 'INTERNAL', message });
    }
  };
}
