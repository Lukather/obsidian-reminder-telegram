import { defineConfig } from 'vitest/config';
import path from 'path';

const srcDir = path.resolve(__dirname, 'src');

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'reports/coverage',
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/settings.ts',
        'src/sidebar-view.ts',
      ],
    },
  },
  resolve: {
    alias: {
      // Mirror tsconfig baseUrl: "src" for bare module imports
      tasks: path.join(srcDir, 'tasks'),
      checker: path.join(srcDir, 'checker'),
      telegram: path.join(srcDir, 'telegram'),
      utils: path.join(srcDir, 'utils'),
      // Resolve obsidian to a mock so tests don't need the real (unresolvable) package
      obsidian: path.resolve(__dirname, '__mocks__/obsidian.ts'),
    },
  },
});
