module.exports = {
  projects: {
    overrides: [
      {
        category: 'UI',
        test: './{build-packages,packages}/mobx*/',
      },
      {
        category: 'Build tooling',
        test: './{build-packages,packages}/{build-util,gulp-*}',
      },
      {
        category: 'Documentation',
        test: './{build-packages,packages}/{writeme-*,markdown-util}',
      },
      {
        category: 'Logging',
        test: './{build-packages,packages}/{winston-formats,logger}',
      },
      {
        category: 'ESLint',
        test: './{build-packages,packages}/tslint*',
      },
      {
        category: 'TSLint',
        test: './{build-packages,packages}/eslint*',
      },
    ],
  },
};
