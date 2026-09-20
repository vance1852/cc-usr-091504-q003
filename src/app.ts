import Fastify, { type FastifyInstance } from 'fastify';
import { openDatabase, type DB } from './db.js';
import { MedicationService } from './services/medicationService.js';
import { registerRoutes } from './http/routes.js';

export interface AppContext {
  app: FastifyInstance;
  db: DB;
  service: MedicationService;
}

export async function buildApp(dbPath: string, logger = true): Promise<AppContext> {
  const app = Fastify({ logger, trustProxy: true });
  const db = openDatabase(dbPath);
  const service = new MedicationService(db);

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));
  await registerRoutes(app, service);

  return { app, db, service };
}
