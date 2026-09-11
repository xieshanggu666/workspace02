import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globals: true,
    hookTimeout: 20000,
  },
  resolve: {
    alias: {
      '@dialect/shared': path.resolve(__dirname, '../../packages/shared/src'),
      '@react-native-async-storage/async-storage': path.resolve(__dirname, 'test/storage-stub.ts'),
    },
  },
});
