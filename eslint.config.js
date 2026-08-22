// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Type-aware linting over src, test, bench, and examples.
 *
 * The rules that matter here are the ones a database package can get quietly wrong:
 * floating promises (an unawaited write that never lands), misused promises (an async
 * callback where a sync one was expected), and unsafe member access on driver results.
 * Formatting is Prettier's job, so `eslint-config-prettier` turns all of that off.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.tgz'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // An adapter method is async because `Executor` and `Repo` are async contracts, not
      // because it happens to do IO. `node:sqlite` is synchronous and its methods still
      // have to return promises; demanding an await there would mean adding a fake one.
      '@typescript-eslint/require-await': 'off',
      // `unknown | null` is redundant to the compiler and informative to a reader: it says
      // the column is nullable, which is the whole point of writing it out.
      '@typescript-eslint/no-redundant-type-constituents': 'off',
    },
  },
  {
    // The conformance suite and the tests deliberately pass wrong types to prove they are
    // rejected, so the assertion-shaped rules would fight the point of those files.
    files: ['test/**/*.ts', 'bench/**/*.ts', 'src/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Separate from the block above on purpose: spreading both into one object would
    // replace the languageOptions that disableTypeChecked sets, and the type-aware parser
    // would come back for files that are not in the TypeScript project.
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: {
        // Plain Node ESM, with no @types/node in scope for the linter.
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
  },
  prettier,
);
