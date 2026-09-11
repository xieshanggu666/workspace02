import { defineConfig } from 'vitest/config';
import * as path from 'path';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    // esbuild 不发出 design:paramtypes，Nest DI 依赖它，测试改用 SWC 转译
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2021',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globals: true,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      '@dialect/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
});
