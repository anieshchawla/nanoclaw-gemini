import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['.gemini/skills/**/tests/*.test.ts'],
  },
});
