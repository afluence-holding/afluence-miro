import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const canvasArtifactSink = {
  name: 'canvas-artifact-sink',
  configureServer(server: {
    middlewares: {
      use: (
        path: string,
        handler: (
          request: AsyncIterable<Uint8Array> & { method?: string },
          response: { statusCode: number; end: (body?: string) => void }
        ) => Promise<void>
      ) => void;
    };
  }) {
    server.middlewares.use('/__canvas-artifact', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.byteLength;
        if (size > 700_000) {
          response.statusCode = 413;
          response.end();
          return;
        }
        chunks.push(chunk);
      }
      const payload = Buffer.concat(chunks).toString('utf8');
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(payload);
      if (!match || payload.length > 700_000) {
        response.statusCode = 400;
        response.end('Expected a bounded PNG data URL.');
        return;
      }
      await writeFile(
        '/tmp/edgeless-ai-render.png',
        Buffer.from(match[1], 'base64')
      );
      response.statusCode = 204;
      response.end();
    });
    server.middlewares.use('/__canvas-benchmark', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.byteLength;
        if (size > 100_000) {
          response.statusCode = 413;
          response.end();
          return;
        }
        chunks.push(chunk);
      }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        await writeFile(
          '/tmp/edgeless-ai-browser-benchmark.json',
          JSON.stringify(payload, null, 2)
        );
        response.statusCode = 204;
      } catch {
        response.statusCode = 400;
      }
      response.end();
    });
  },
};

/** Browser-only canvas integration funnel: one real Chromium editor at a time. */
export default defineConfig({
  root: './blocksuite/integration-test',
  define: {
    BUILD_CONFIG: JSON.stringify({
      isElectron: false,
      isIOS: false,
      isAndroid: false,
      isWeb: true,
      isMobileWeb: false,
      isMobileEdition: false,
      isNative: false,
      appBuildType: 'canary',
      appVersion: 'test',
      debug: false,
    }),
  },
  resolve: {
    alias: {
      '@affine/core': resolve(__dirname, 'packages/frontend/core/src'),
    },
  },
  server: {
    fs: { allow: ['..', '/tmp'] },
  },
  esbuild: { target: 'es2018' },
  optimizeDeps: {
    force: true,
    esbuildOptions: { target: 'es2022' },
  },
  plugins: [canvasArtifactSink, vanillaExtractPlugin()],
  test: {
    include: [
      'src/__tests__/edgeless/{canvas-ai,native-blocks-all,native-jobs,native-new-document,canvas-benchmark}.spec.ts',
    ],
    fileParallelism: false,
    sequence: { concurrent: false },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      isolate: false,
      viewport: { width: 1024, height: 768 },
    },
  },
});
