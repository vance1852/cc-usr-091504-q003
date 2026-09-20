# 课后托管用药保管与执行记录服务

面向课后托管教师、学校管理人员与学生监护人的用药管理服务。系统在**不提供任何医疗诊断或剂量建议**的前提下，
把家长的书面授权、校方的双人核对、跨班交接、实际执行与异常处置串成可审计的责任链。

- **运行时**：Node.js 22 + TypeScript（严格模式）
- **HTTP**：Fastify 5
- **存储**：SQLite（Node 内置 `node:sqlite`，WAL 模式，无原生编译依赖）
- **并发保证**：`BEGIN IMMEDIATE` 事务 + 数据库唯一索引 + 动作幂等键

## 业务原则

1. **校方只执行、不判断**：教师/护士不做诊断、不调整剂量。药盒标签与线上书面指示的药名/剂量由服务端机械比对，不一致即冲突。
2. **书面授权版本化**：家长提交的每次指示都是不可删除的新版本；变更后旧版 `superseded`，在新版完成双人核对前冻结执行。
3. **双人核对**：接收后须两名不同在岗人员核对授权版本、标签一致性、包装与保管条件。
4. **冻结优先**：信息冲突、授权到期、药品过期、包装破损、保管条件失效一律冻结执行，并通知家长与指定负责人。
5. **执行不可变**：实际执行一经确认即落库，数据库触发器禁止 `UPDATE`/`DELETE`；漏执行、学生拒绝、剂量误差只能通过**差错事件追加**。
6. **扫码幂等**：每个扫码动作携带幂等键（`X-Idempotency-Key` 或 `deviceId + clientEventId`），重复扫码/网络重试/离线重放只回放首次结果，不产生第二次动作。
7. **交接链连续**：跨班交接要求实物数量与账面数量完全一致，交接后保管人即时变更，`receive → handoff* → return` 全程留痕。
8. **双向视图**：家长只看到本人孩子的确认状态、执行与异常通知；学校审计可从任意一次执行追到授权版本、核对人员、交接链与剩余数量。

## 快速开始

```bash
npm install
npm test          # 37 个测试：生命周期、并发领取、指示变更、离线补传、HTTP 端到端
npm start         # 默认 http://localhost:3000，DB 在 ./data/medications.db
# 可选环境变量：PORT、DB_PATH、SWEEP_INTERVAL_MS（授权到期巡检间隔，默认 10 分钟）
```

> 需要 Node 22（使用内置 SQLite，启动参数 `--experimental-sqlite` 已写入脚本）。

## 角色与认证

启动后通过 `/admin/*` 初始化数据（仅演示用，preHandler 中跳过鉴权）：

| 角色 | 凭证 | 能力 |
| --- | --- | --- |
| 家长 guardian | Bearer token | 登记药品与指示、提交指示变更、查看本人孩子视图与通知 |
| 校方 staff（teacher/nurse） | Bearer token | 接收、双人核对、交接、执行、退回、差错追加、审计查询 |
| 指定负责人 coordinator（responsible=true） | Bearer token | 额外接收全部冻结/冲突通知、触发到期巡检 |

## 主要接口

### 家长端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/guardian/medications` | 登记药品：包装条码、标签药名/剂量、有效期、保管条件、数量、首版书面指示、紧急联系人随监护人档案 |
| POST | `/guardian/medications/:medId/instruction-versions` | 提交指示变更（新版本，立即冻结至重新核对） |
| GET | `/guardian/view` | 本人孩子药品状态、最新指示版本、双人核对结论、近期执行/差错、通知 |
| GET | `/guardian/notifications` | 本人相关通知 |

### 校方端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/staff/medications/:medId/receive` | 接收（查有效期/包装/保管条件），幂等 |
| POST | `/staff/medications/:medId/verify` | 双人核对 `{staff1Id, staff2Id, storageMet}`，服务端比对标签与指示 |
| POST | `/staff/medications/:medId/handoff` | 跨班交接 `{toStaffId, quantity}`，数量不符即 409 |
| POST | `/staff/medications/:medId/execute` | 按计划时点执行 `{scheduledTime, administeredQty, occurredAt?}`，幂等 |
| POST | `/staff/medications/:medId/incidents` | 追加差错 `{type: missed_dose/student_refused/dose_deviation/package_damaged/storage_breach/other}` |
| POST | `/staff/medications/:medId/return` | 退回家长，结束保管链 |
| POST | `/staff/medications/:medId/backfill` | 离线补传 `{events:[{kind, clientEventId, deviceId, occurredAt,...}]}` |
| GET | `/staff/medications/:medId/audit` | 审计视图：授权版本、核对人员、交接链、执行/差错/冻结史、剩余数量 |
| GET | `/staff/executions/:executionId/trace` | 从单次执行回溯授权版本、核对人员、当时交接链、当前余量 |
| GET | `/staff/notifications` | 负责人通知 |
| POST | `/staff/sweep-expirations` | 手动触发授权/药品到期巡检（服务每 10 分钟自动执行） |

### 幂等约定

- 优先使用请求头 `X-Idempotency-Key: <deviceId>:<clientEventId>`；
- 或在 body 中提供 `deviceId` + `clientEventId`；
- 命中重复键返回 `200 { replayed: true, result: <首次响应> }`；
- 同一药品同一天同一计划时点有唯一索引兜底：不同幂等键的并发抢占，第二个得到 `409 slot_already_executed`。

### 冻结原因（`freeze_reason`）

`info_conflict`（标签与指示不一致）、`auth_expired`（授权/药品过期）、`package_damaged`、`storage_breach`、
`instruction_change_pending`（新指示待核对）。冻结期间执行、交接语义见服务层规则：执行一律拒绝；交接仍允许（保证责任连续），
但冻结状态随药品带到新保管人。

## 数据模型要点

- `authorizations`：指示版本链（pending/active/superseded/expired），永不删除。
- `verifications`：每次双人核对全量保留（含 conflict 明细），冲突解决后允许同版本再次核对。
- `custody_events`：receive/return 各有数据库级唯一索引，重复扫码无法产生第二次。
- `executions`：`(medication_id, scheduled_date, scheduled_time)` 唯一；触发器禁止改删。
- `incidents`：追加式，触发器禁止改删；包装/保管类事件自动联动冻结。
- `freeze_events` / `notifications`：冻结解冻史与双方通知留痕。
- `action_idempotency`：幂等键与业务数据在同一事务内先占位后执行业务，支持跨连接/跨线程竞争。

## 端到端验证

```bash
# 终端 1
DB_PATH=/tmp/demo.db PORT=3211 npm start
# 终端 2
bash scripts/smoke.sh   # 登记→接收(幂等重试)→双人核对→执行→交接→差错→退回→家长视图→审计视图
```

真实并发场景由 `test/concurrency.test.ts` 使用 `worker_threads` + 独立 SQLite 连接验证：
两名工作人员同时领取同一时点恰好一次落库；同一扫码事件双发时一方回放首次结果，数量只扣一次。
