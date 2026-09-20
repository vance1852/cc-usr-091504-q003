import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { MedicationService } from '../src/services/medicationService.js';
import { baseInstruction, tempDbPath } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const workerFile = join(here, 'executeWorker.ts');

interface WorkerResult {
  ok: boolean;
  executionId?: string;
  code?: string | null;
  name?: string;
}

function runWorker(data: Record<string, unknown>): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerFile, { workerData: data });
    w.on('message', (msg: WorkerResult) => resolve(msg));
    w.on('error', reject);
    w.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker 退出码 ${code}`));
    });
  });
}

function seed(path: string) {
  const svc = new MedicationService(openDatabase(path));
  const g = svc.createGuardian({ name: '家长', phone: '1', emergencyPhone: '2' });
  const stu = svc.createStudent(g.id, '学生');
  const a = svc.createStaff({ name: 'A', role: 'teacher' });
  const b = svc.createStaff({ name: 'B', role: 'teacher' });
  const med = svc.registerMedication({
    guardianId: g.id, studentId: stu.id, packageCode: 'P', labelDrugName: '阿莫西林', labelDoseText: '5ml',
    expiryDate: '2027-01-01', storageRequirement: 'room_temp', initialQuantity: 20, quantityUnit: 'ml',
    instruction: baseInstruction,
  });
  svc.receive(a.id, med.medicationId, { packageIntact: true, storageMet: true });
  svc.verify(a.id, med.medicationId, { staff1Id: a.id, staff2Id: b.id, storageMet: true });
  return { medId: med.medicationId, staffId: a.id };
}

describe('真实并发领取（worker_threads + WAL）', () => {
  it('不同幂等键同时抢同一计划时点：仅一次落库，另一方收到 slot_already_executed', async () => {
    const path = tempDbPath();
    const { medId, staffId } = seed(path);

    const [r1, r2] = await Promise.all([
      runWorker({ dbPath: path, staffId, medId, key: 'dev-A:evt-1', deviceId: 'dev-A', date: '2026-09-23' }),
      runWorker({ dbPath: path, staffId, medId, key: 'dev-B:evt-9', deviceId: 'dev-B', date: '2026-09-23' }),
    ]);

    const wins = [r1, r2].filter((r) => r.ok);
    const loses = [r1, r2].filter((r) => !r.ok);
    assert.equal(wins.length, 1, '恰有一个执行者成功');
    assert.equal(loses.length, 1);
    assert.equal(loses[0]!.code, 'slot_already_executed');

    const db = openDatabase(path);
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM executions`).get() as any).c, 1);
    assert.equal((db.prepare(`SELECT current_quantity q FROM medications WHERE id = ?`).get(medId) as any).q, 15);
  });

  it('相同扫码事件重放（网络重试/双端发送）：回放首次结果且只扣一次数量', async () => {
    const path = tempDbPath();
    const { medId, staffId } = seed(path);

    const [r1, r2] = await Promise.all([
      runWorker({ dbPath: path, staffId, medId, key: 'dev-X:same-event', deviceId: 'dev-X', date: '2026-09-24' }),
      runWorker({ dbPath: path, staffId, medId, key: 'dev-X:same-event', deviceId: 'dev-X', date: '2026-09-24' }),
    ]);

    assert.ok(r1.ok || r2.ok);
    const replays = [r1, r2].filter((r) => r.name === 'IdempotentReplay');
    assert.equal(replays.length, 1, '另一方应收到幂等回放');

    const db = openDatabase(path);
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM executions`).get() as any).c, 1);
    assert.equal((db.prepare(`SELECT current_quantity q FROM medications WHERE id = ?`).get(medId) as any).q, 15);
  });
});
