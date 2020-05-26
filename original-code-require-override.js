const { readFileSync, accessSync, constants } = require('fs');
const Module = require('module');

const { join } = require('path');

const globby = require('globby');

const config = require('@monorepo/config');

const packageDirs = globby.sync(config.workspaces, {
  onlyDirectories: true,
});

const packageJsonFilePaths = packageDirs.map((dir) => join(dir, 'package.json'));

const readablePackageJsonFilePaths = packageJsonFilePaths.filter((filePath) => {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch (err) {
    console.log(err);
    return false;
  }
});

const packageJsons = readablePackageJsonFilePaths.map((filePath) =>
  JSON.parse(readFileSync(filePath, 'utf8')),
);

const workspacedPackageNames = new Map(
  packageJsons
    .filter(
      (json) =>
        json.exports !== undefined && json.exports['monorepo-original'] !== undefined,
    )
    .map((json) => [json.name, join(json.name, json.exports['monorepo-original'])]),
);

const { require: oldRequire } = Module.prototype;

Module.prototype.require = function require(filePath, ...other) {
  const patchedFilePath = (() => {
    if (workspacedPackageNames.has(filePath)) {
      return workspacedPackageNames.get(filePath);
    } else {
      return filePath;
    }
  })();
  return oldRequire.apply(this, [patchedFilePath, ...other]);
};