import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Isolated server protocol tests do not boot PostgreSQL, Redis or native LLMs.
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        target: 'es2022',
        transform: { decoratorVersion: '2022-03' },
      },
    }),
  ],
  test: {
    include: [
      'packages/backend/server/src/plugins/copilot/{delegated,tools}/**/*.test.ts',
    ],
    environment: 'node',
  },
});
