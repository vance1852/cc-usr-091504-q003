/** 业务规则错误：携带 HTTP 状态码与机器可读 code，路由层统一映射。 */
export class DomainError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new DomainError(400, 'bad_request', message, details);
  }
  static unauthorized(message = '未授权') {
    return new DomainError(401, 'unauthorized', message);
  }
  static forbidden(message: string) {
    return new DomainError(403, 'forbidden', message);
  }
  static notFound(message = '资源不存在') {
    return new DomainError(404, 'not_found', message);
  }
  static conflict(code: string, message: string, details?: unknown) {
    return new DomainError(409, code, message, details);
  }
}
