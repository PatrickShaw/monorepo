module.exports = {
  extends: ['eslint:recommended'],
  rules: {
    quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    'no-console': 'error',
    'no-empty': 'error',
    'no-unused-vars': 'error',
    'object-literal-sort-keys': 'off',
    'ordered-imports': [
      true,
      {
        'named-imports-order': 'any',
      },
    ],
    'prefer-template': 'error',
  },
};