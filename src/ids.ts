import { randomBytes, randomUUID } from 'node:crypto';

/** 业务主键：类型前缀 + UUID，便于审计阅读。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** 家长令牌 / 员工令牌等不透明凭据。 */
export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}
