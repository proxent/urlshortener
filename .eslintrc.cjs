/** @type {import('eslint').Linter.Config} */
module.exports = {
    root: true,
    env: { node: true, es2020: true },
    parser: '@typescript-eslint/parser',
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: ['@typescript-eslint', 'prettier'],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:prettier/recommended'
    ],
    rules: {
        'prettier/prettier': 'warn',
        '@typescript-eslint/no-unused-vars': [
            'warn',
            { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
        ]
    },
    ignorePatterns: ['dist', 'node_modules']
};
