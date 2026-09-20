import { buildApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? './data/medications.db';
// 授权到期巡检间隔（毫秒），默认 10 分钟
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 10 * 60 * 1000);

const { app, service } = await buildApp(DB_PATH);

// 定时冻结：授权到期 / 药品过期
const sweep = () => {
  try {
    const r = service.sweepExpirations();
    if (r.frozen.length > 0) app.log.warn({ frozen: r.frozen }, 'sweep froze medications');
  } catch (err) {
    app.log.error({ err }, 'sweep failed');
  }
};
const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
sweepTimer.unref();

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(`用药保管服务已启动: http://localhost:${PORT}`);

const shutdown = async () => {
  clearInterval(sweepTimer);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
