import { join, relative } from 'path';
import { pathExists } from 'fs-extra';
import { writeFile, readFile } from 'mz/fs';
import { fromSchema, mergeHookOptions, HookOptionsOf } from 'hook-schema';
import globby from 'globby';

function section(title, content) {
  let md = '';
  if (content) {
    md += `## ${title}\n`;
    md += '\n';
    md += content;
    md += '\n';
  }
  return md;
}

export interface Sections {
  examples?: string;
  howTo?: string;
  development?: string;
}

export interface ManualReadmeContents {
  isDevPackage?: boolean;
  sections?: Sections;
}

export interface ReadmeContents extends ManualReadmeContents {
  title: string;
  name: string;
  version: string;
  description?: string;
  private?: boolean;
  peerDependencies?: { [s: string]: string };
}

const suffixedVersionRegex = /\d+\.\d+\.\d+-/;

function packageInstallation(command, flag, packageNames) {
  let md = '';
  md += '```bash\n';
  md += `${command}${flag} ${packageNames.join(' ')}\n`;
  md += '```\n';
  return md;
}

function installationInstructions(isDevPackage, allDependenciesToInstall) {
  const yarnSaveFlag = isDevPackage ? ' --dev' : '';
  const npmSaveFlag = isDevPackage ? ' --save-dev' : ' --save';
  let md = '';
  md += packageInstallation('npm install', npmSaveFlag, allDependenciesToInstall);
  md += 'or\n';
  md += packageInstallation('yarn add', yarnSaveFlag, allDependenciesToInstall);
  md += '\n';
  return md;
}

function genReadme({
  name,
  version,
  isDevPackage,
  description,
  sections = {},
  peerDependencies = {},
  ...other
}: ReadmeContents) {
  const title = packageNameToTitle(name);
  const { examples, howTo, development = '' } = sections;
  if (!name) {
    throw new Error(`Name was ${name}`);
  }

  let md = '';
  md += `# ${title}\n`;
  md += '\n';
  if (description) {
    md += `${description}\n`;
    md += '\n';
  }
  if (other.private !== true) {
    if (!version) {
      throw new Error(`${name} does not have a version`);
    }
    md += '## Installation\n';
    md += '\n';
    const installPackageName = version.match(suffixedVersionRegex)
      ? `${name}@${version}`
      : name;

    const peerDependenciesToInstall = Object.keys(peerDependencies);
    const allDependenciesToInstall = [installPackageName].concat(
      ...Array.from(peerDependenciesToInstall),
    );

    md += installationInstructions(isDevPackage, allDependenciesToInstall);
  }
  md += section('How to use it', howTo);
  md += section('Examples', examples);
  md += section('Development', development);
  return md;
}

async function readPackageJson(packageDir) {
  const packageJsonText = await readFile(join(packageDir, 'package.json'), {
    encoding: 'utf-8',
  });
  return JSON.parse(packageJsonText);
}

/**
 * Removes @ scopes, replaces "-"" with a space and capitalises each word
 */
function packageNameToTitle(packageName: string) {
  return packageName
    .replace(/^@[^\/]+\//, '')
    .replace(/-+/, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
}

export type MissingFileCallback = (configPath: string) => any;

const genReadmeFromPackageDirSchema = {
  readConfig: null,
  readPackageJson: null,
  genReadme: null,
};
const errorSchema = {
  error: null,
};

const genReadmeFromPackageDirHookUtil = fromSchema(
  genReadmeFromPackageDirSchema,
  errorSchema,
);
export type GenReadmeFromPackageDirHooks = HookOptionsOf<
  typeof genReadmeFromPackageDirHookUtil
>;

function getProjects(writemeOptions) {
  if (writemeOptions.projects === undefined) {
    return undefined;
  } else if (!writemeOptions.projects) {
    return null;
  } else if (!!writemeOptions.projects.test) {
    return writemeOptions.projects;
  } else if (!writemeOptions.workspaces) {
    throw new Error(
      "Projects object does not have 'test' field, nor does package.json have 'workspaces'",
    );
  } else {
    return {
      ...writemeOptions.projects,
      test: writemeOptions.workspaces,
    };
  }
}

function testToGlobs(test: string | string[]) {
  if (typeof test === 'string') {
    return [test];
  } else {
    return test;
  }
}

async function testToPaths(packageDir: string, test: string | string[]) {
  if (!test) {
    throw new Error("'test' was undefined");
  }
  const joinedGlobs = testToGlobs(test).map(glob => join(packageDir, glob));
  return await globby(joinedGlobs, { onlyFiles: false });
}

export async function genReadmeFromPackageDir(
  packageDir: string,
  hooks: GenReadmeFromPackageDirHooks,
) {
  const h = genReadmeFromPackageDirHookUtil.withHooks(hooks);
  const context: any = { packageDir };
  async function readConfig() {
    context.configRequirePath = join(context.packageDir, 'writeme.config');
    context.configPath = `${context.configRequirePath}.js`;
    async function getConfigModule() {
      if (await pathExists(context.configPath)) {
        return require(context.configPath);
      } else {
        return null;
      }
    }
    const configModule = await getConfigModule();
    const configModuleType = typeof configModule;
    if (configModuleType === 'function') {
      return await Promise.resolve(configModule());
    } else {
      return configModule;
    }
  }
  try {
    await h.before.readPackageJson(context);
    context.packageJson = await readPackageJson(context.packageDir);
    await h.after.readPackageJson(context);

    await h.before.readConfig(context);
    context.config = await readConfig();
    await h.after.readConfig(context);
    context.writemeOptions = {
      ...context.packageJson,
      ...context.config,
    };
    context.projects = getProjects(context.writemeOptions);
    if (context.projects) {
      const overrideProjects: any[] = context.projects.overrides
        ? await Promise.all(
            context.projects.overrides.map(async project => ({
              ...project,
              testPaths: await testToPaths(packageDir, project.test),
            })),
          )
        : [];
      const defaultPaths = await testToPaths(packageDir, context.projects.test);
      const allProjects = overrideProjects.concat({
        ...context.projects,
        testPaths: defaultPaths.filter(
          path => !overrideProjects.some(project => project.testPaths.includes(path)),
        ),
      });

      await Promise.all(
        allProjects.map(
          async project =>
            await Promise.all(
              project.testPaths.map(path => genReadmeFromPackageDir(path, h)),
            ),
        ),
      );
    }

    await h.before.genReadme(context);
    context.readmeText = genReadme(context.writemeOptions);
    await h.after.genReadme(context);

    return context.readmeText;
  } catch (err) {
    await h.on.error(err);
  }
}

const writeReadmeFromPackageDirHookSchema = {
  ...genReadmeFromPackageDirSchema,
  writeReadme: null,
};
const writeReadmeFromPackageDirUtil = fromSchema(
  writeReadmeFromPackageDirHookSchema,
  errorSchema,
);
export type WriteReadmeFromPackageDirHooks = HookOptionsOf<
  typeof writeReadmeFromPackageDirUtil
>;

export async function writeReadmeFromPackageDir(
  packageDir: string,
  hooks: WriteReadmeFromPackageDirHooks,
) {
  const h = writeReadmeFromPackageDirUtil.withHooks(hooks);
  await genReadmeFromPackageDir(
    packageDir,
    writeReadmeFromPackageDirUtil.mergeHookOptions([
      {
        after: {
          async genReadme(context) {
            await h.before.writeReadme(context);
            await writeFile(join(packageDir, 'README.md'), context.readmeText, {
              encoding: 'utf-8',
            });
            await h.after.writeReadme(context);
          },
        },
      },
      h,
    ]),
  );
}
export default writeReadmeFromPackageDir;
