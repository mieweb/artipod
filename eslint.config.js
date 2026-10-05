import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig({
  files: ['src/**/*.ts'],
  extends: [js.configs.recommended, tsPlugin.configs['flat/recommended']],
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: import.meta.dirname,
    },
    globals: {
      ...globals.node,
      ...globals.jest,
    },
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // Preserve checks removed or relaxed in the newer recommended preset.
    'no-constant-condition': ['error', { checkLoops: 'all' }],
    'no-extra-semi': 'error',
    'no-inner-declarations': ['error', 'functions', { blockScopedFunctions: 'disallow' }],
    'no-mixed-spaces-and-tabs': 'error',
  },
});
