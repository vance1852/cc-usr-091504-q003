import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // forks 池让子进程继承 NODE_OPTIONS（用于屏蔽 node:sqlite 实验性警告）
    pool: 'forks',
    include: ['test/**/*.test.ts'],
  },
});
