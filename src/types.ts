export type Role = 'parent' | 'staff' | 'manager' | 'auditor';

/** 已认证的请求者（来自 users 表） */
export interface Actor {
  id: string;
  name: string;
  role: Role;
}

export type Row = Record<string, any>;
