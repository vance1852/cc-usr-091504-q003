import { workerData, parentPort } from 'node:worker_threads';
import { openDatabase } from '../src/db.js';
import { MedicationService, IdempotentReplay } from '../src/services/medicationService.js';

try {
  const svc = new MedicationService(openDatabase(workerData.dbPath));
  const r = svc.execute(
    workerData.staffId,
    workerData.medId,
    { scheduledTime: '16:30', administeredQty: 5, scheduledDate: workerData.date },
    { key: workerData.key, deviceId: workerData.deviceId ?? 'd' },
  );
  parentPort!.postMessage({ ok: true, executionId: r.executionId });
} catch (e: unknown) {
  const err = e as { code?: string; name?: string; payload?: unknown };
  parentPort!.postMessage({
    ok: false,
    code: err.code ?? null,
    name: err instanceof IdempotentReplay ? 'IdempotentReplay' : (err.name ?? 'Error'),
    payload: err instanceof IdempotentReplay ? err.payload : undefined,
  });
}
