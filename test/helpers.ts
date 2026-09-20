import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../src/db.js';
import { MedicationService } from '../src/services/medicationService.js';
import type { WrittenInstruction } from '../src/domain/types.js';

export function makeService(db?: DB) {
  const database = db ?? openDatabase(':memory:');
  return { db: database, service: new MedicationService(database) };
}

export function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'med-test-'));
  return join(dir, 'test.db');
}

export const baseInstruction: WrittenInstruction = {
  drugName: '阿莫西林',
  form: 'liquid',
  doseText: '5ml',
  route: 'oral',
  scheduledTimes: ['16:30'],
  validFrom: '2026-09-01',
  validUntil: '2026-09-30',
  notes: '饭后服用',
};

export interface Fixture {
  db: DB;
  service: MedicationService;
  guardianId: string;
  guardianToken: string;
  studentId: string;
  staffA: { id: string; token: string; name: string };
  staffB: { id: string; token: string; name: string };
  responsible: { id: string; token: string; name: string };
  medicationId: string;
}

/** 建立家长/学生/两名教师/负责人，并登记一件标签与指示一致的药品（待接收）。 */
export function setupFixture(overrides?: { labelDoseText?: string; labelDrugName?: string; validUntil?: string; expiryDate?: string }): Fixture {
  const { db, service } = makeService();
  const guardian = service.createGuardian({ name: '王家长', phone: '13800000001', emergencyPhone: '13900000001', emergencyNote: '孩子奶奶' });
  const student = service.createStudent(guardian.id, '王小明');
  const a = service.createStaff({ name: '李老师', role: 'teacher' });
  const b = service.createStaff({ name: '赵老师', role: 'teacher' });
  const r = service.createStaff({ name: '陈负责人', role: 'coordinator', responsible: true });

  const med = service.registerMedication({
    guardianId: guardian.id,
    studentId: student.id,
    packageCode: 'PKG-0001',
    labelDrugName: overrides?.labelDrugName ?? '阿莫西林',
    labelDoseText: overrides?.labelDoseText ?? '5ml',
    expiryDate: overrides?.expiryDate ?? '2027-01-01',
    storageRequirement: 'room_temp',
    initialQuantity: 20,
    quantityUnit: 'ml',
    instruction: { ...baseInstruction, validUntil: overrides?.validUntil ?? baseInstruction.validUntil },
  });

  return {
    db,
    service,
    guardianId: guardian.id,
    guardianToken: guardian.token,
    studentId: student.id,
    staffA: { id: a.id, token: a.token, name: a.name },
    staffB: { id: b.id, token: b.token, name: b.name },
    responsible: { id: r.id, token: r.token, name: r.name },
    medicationId: med.medicationId,
  };
}

/** 接收 + 双人核对通过，药品进入可执行状态。 */
export function reachCustody(f: Fixture, storageMet = true) {
  serviceReceive(f);
  const v = f.service.verify(f.staffA.id, f.medicationId, {
    staff1Id: f.staffA.id,
    staff2Id: f.staffB.id,
    storageMet,
  });
  return v;
}

export function serviceReceive(f: Fixture, opts: { packageIntact?: boolean; storageMet?: boolean } = {}) {
  return f.service.receive(
    f.staffA.id,
    f.medicationId,
    { packageIntact: opts.packageIntact ?? true, storageMet: opts.storageMet ?? true },
    { key: `recv-${f.medicationId}` },
  );
}

export function executeDose(f: Fixture, opts: { time?: string; qty?: number; idemKey?: string; date?: string; occurredAt?: string } = {}) {
  return f.service.execute(
    opts.idemKey ? f.staffA.id : f.staffA.id,
    f.medicationId,
    {
      scheduledTime: opts.time ?? '16:30',
      administeredQty: opts.qty ?? 5,
      scheduledDate: opts.date,
      occurredAt: opts.occurredAt,
    },
    opts.idemKey ? { key: opts.idemKey, deviceId: 'scanner-1' } : undefined,
  );
}
