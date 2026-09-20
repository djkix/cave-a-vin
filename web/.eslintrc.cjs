module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:react-hooks/recommended'],
  root: true,
  env: { browser: true, es2022: true },
  ignorePatterns: ['.eslintrc.cjs', 'dist', 'vite.config.ts', 'vitest.config.ts', 'scripts'],
};
