import { defineConfig, globalIgnores } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'node_modules/', 'coverage/', 'graphify-out/', 'blueprint-extract/', 'scripts/**/*.mjs']),
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // src/ is covered by tsconfig.json; tests/ by tests/tsconfig.json;
        // the two standalone config files ride the default project.
        projectService: {
          allowDefaultProject: ['eslint.config.ts', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Entry points are process-level scripts; allow direct stdio logging.
      'no-console': 'off',
      // Boundary code (HTTP bridge) legitimately touches unknown shapes after narrowing.
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  {
    // Tests: keep type safety but relax stylistic-only rules that fight fixtures.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // jsdom-driven UI contract tests drive the page's own script scope
      // (window.eval); DOM types resolve only under the DOM lib, which the
      // server tsconfig deliberately excludes. The flagged calls are
      // fixture code driving the REAL shipped page script.
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
