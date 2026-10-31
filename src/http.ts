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
