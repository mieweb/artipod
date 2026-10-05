import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
  recommendedConfig: js.configs.recommended,
});

export default [
  // Make the rules formerly inherited from the repository's .eslintrc
  // explicit: flat configs do not merge parent-directory configurations.
  ...compat.config({
    extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'next/core-web-vitals'],
    parserOptions: { project: './tsconfig.json' },
    env: { node: true, jest: true },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // ESLint 9 removed these from eslint:recommended or relaxed defaults.
      'no-constant-condition': ['error', { checkLoops: 'all' }],
      'no-extra-semi': 'error',
      'no-inner-declarations': ['error', 'functions', { blockScopedFunctions: 'disallow' }],
      'no-mixed-spaces-and-tabs': 'error',
    },
  }),
  {
    ignores: [
      '.next/**',
      'out/**',
      'next-env.d.ts',
      'public/kerebron-wasm/**',
      'public/artipod-runtime-sw.js',
    ],
  },
];
