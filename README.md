# 课后托管用药保管服务

本项目面向课后托管教师、学校管理人员和学生监护人，用于记录学生自带药品的接收、保管、交接与执行情况。

系统强调书面授权、双人核对和责任连续性，帮助学校在不提供医疗判断的前提下处理信息冲突与异常事件。

## 技术栈

- **Fastify 5** — HTTP 层（JSON Schema 校验请求体）
- **SQLite** — 通过 Node 22 内置 `node:sqlite` 访问（`src/sqlite.ts` 提供 better-sqlite3 兼容的最小接口，无原生编译依赖）
- **TypeScript** + tsx / vitest

## 运行

```bash
npm install
npm start          # 默认 3000 端口，DB_PATH 可指定 SQLite 文件（默认 ./data.sqlite）
npm test           # 29 个用例：完整流程/冻结/指示变更/幂等/并发/离线补传/差错/权限
npm run typecheck
```

身份通过请求头 `x-actor-id` 识别（演示用户见 `src/db.ts` seed：`u-parent-1/2`、`u-staff-1/2/3`、`u-mgr-1`、`u-audit-1`）。保管类写操作还要求 `idempotency-key` 请求头。

## 核心设计

- **版本化书面指示（authorizations）**：家长提交药品身份、有效期、保管条件、书面指示原文、紧急联系人；校方确认后生效，确认新版本自动作废旧版本。系统只照录与核对指示，不做诊断或剂量建议。
- **追加式账本（custody_events / deviations）**：接收、双人核对、交接、执行、退回全部入账；数据库触发器禁止 UPDATE/DELETE，执行一经确认不可删除。漏执行、学生拒绝、用量误差以差错事件（deviations）追加，原记录不变。
- **冻结（freezes）**：信息冲突（药盒标签与线上指示不符、实收数量不符、家长提交新指示版本）、授权到期、药品过期、包装破损、保管条件失效 → 自动/人工冻结执行并通知指定负责人与家长；负责人核实后解除。冻结只阻断执行，交接（保管责任连续性）不受影响。
- **幂等**：每个保管事件携带唯一 `idempotency_key`，重复扫码返回首次结果；`(药品, 日期, 时段)` 部分唯一索引保证同一时段至多执行一次，即使换了幂等键。
- **并发安全**：交接/执行在事务内校验账面保管人与数量（乐观锁），并发领取只有一笔成功，其余收到 409。
- **离线补传**：`POST /api/events/batch` 接收携带 `client_event_id` 与实际发生时间的离线事件，逐条独立事务处理，重传判重（applied / duplicate / rejected）。

## API 一览

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/medications` | parent | 提交药品（身份/有效期/保管条件/数量） |
| POST | `/api/medications/:id/authorizations` | parent | 提交书面指示新版本（已有确认版本时自动冻结） |
| POST | `/api/authorizations/:id/confirm` | staff/manager | 确认指示版本（旧版本自动作废） |
| POST | `/api/medications/:id/receive` | staff | 接收（可上报标签冲突/数量冲突） |
| POST | `/api/medications/:id/dual-check` | staff | 双人核对（两名不同校方人员） |
| POST | `/api/medications/:id/handover` | staff | 交接（可跨班，校验保管人与数量） |
| POST | `/api/medications/:id/execute` | staff | 执行给药（双人、授权有效期内、幂等） |
| POST | `/api/medications/:id/return` | staff | 退回家长 |
| POST | `/api/medications/:id/freezes` | staff/manager | 上报异常并冻结 |
| POST | `/api/freezes/:id/resolve` | manager | 负责人解除冻结 |
| POST | `/api/medications/:id/deviations` | staff | 差错事件（MISSED/REFUSED/DOSE_ERROR） |
| POST | `/api/events/batch` | staff | 离线补传 |
| GET | `/api/parent/students/:id/status` | parent | 本人孩子的确认状态与异常通知 |
| GET | `/api/notifications` | 任意 | 本人的通知 |
| GET | `/api/medications/:id` | staff 等 | 药品当前状态（家长限本人孩子） |
| GET | `/api/audit/medications/:id/trace` | auditor/manager | 全链路：授权版本、核对、交接链、差错、剩余数量 |
| GET | `/api/audit/executions/:id` | auditor/manager | 从一次执行追到授权版本、核对人员、交接链、剩余数量 |

错误统一为 `{ "error": { "code", "message" } }`；业务冲突返回 409（如 `MEDICATION_FROZEN`、`AUTH_SUPERSEDED`、`SLOT_ALREADY_EXECUTED`、`CUSTODY_MISMATCH`、`QUANTITY_MISMATCH`）。
