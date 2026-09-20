import { buildApp } from './app';
import { createDb, seed } from './db';

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? './data.sqlite';

const db = createDb(dbPath);
seed(db);

const app = buildApp({ db });

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    console.log(`用药保管服务已启动: http://localhost:${port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
