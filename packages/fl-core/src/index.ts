import globby from 'globby';
import { fork } from 'child_process';
import { cpus } from 'os';
import * as types from 'fl-addon-message-types';
import { AssertionResult, ExecutionResult, TestResult } from 'fl-addon-core';

const runInSeperateProcesses = async (directories, processCount, absoluteImportPaths) => {
  await new Promise((resolve, reject) => {
    let processesStillRunning = processCount;
    const forkForTest = testPath => {
      return fork(
        require.resolve('./addon-entry'),
        [
          'fl-addon-mocha',
          JSON.stringify([testPath]),
          JSON.stringify(absoluteImportPaths),
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: 'test',
          },
        },
      );
    };

    const runNextTest = () => {
      if (directories.length <= 0) {
        processesStillRunning--;
        if (processesStillRunning <= 0) {
          resolve();
        }
        return;
      }
      const testPath = directories.pop() as string;
      const testFork = forkForTest(testPath);

      testFork.on('exit', () => {
        runNextTest();
      });
    };

    for (let i = 0; i < processCount && directories.length > 0; i++) {
      runNextTest();
    }
  });
};

const runAndRecycleProcesses = async (directories, processCount, absoluteImportPaths) => {
  const testsPerWorkerWithoutRemainder = Math.floor(directories.length / processCount);
  const remainders = directories.length % processCount;
  let i = 0;
  const testResults: any[] = [];
  const forkForTest = testPaths => {
    const forkTest = fork(
      require.resolve('./addonEntry'),
      ['fl-addon-mocha', JSON.stringify(testPaths), JSON.stringify(absoluteImportPaths)],
      {
        env: {
          ...process.env,
          NODE_ENV: 'test',
        },
      },
    );
    return new Promise((resolve, reject) => {
      forkTest.on('message', (message: ExecutionResult | AssertionResult | TestResult) => {
        console.log(message);
        switch (message.type) {
          case types.EXECUTION:
            console.log(testResults);
            resolve(message.passed);
            break;
          case types.TEST:
            testResults.push(message);
            break;
        }
      });
      forkTest.on('exit', code => {
        if (code !== 0) {
          reject(new Error('An error ocurred while running tests'));
        }
      });
    });
  };

  let forkPromises: any[] = [];
  while (i < remainders) {
    const testPaths = directories.splice(0, testsPerWorkerWithoutRemainder + 1);
    forkPromises[i] = forkForTest(testPaths);
    i++;
  }
  if (testsPerWorkerWithoutRemainder > 0) {
    while (i < processCount) {
      const testPaths = directories.splice(0, testsPerWorkerWithoutRemainder);
      forkPromises[i] = forkForTest(testPaths);
      i++;
    }
  }

  await Promise.all(forkPromises);
};

export const run = async ({
  testMatch,
  setupFiles,
}) => {
  const directories = await globby(
    testMatch,
    { onlyFiles: true },
  );
  // We pop the paths off the end of the list so the first path thing needs to be at the end
  directories.reverse();

  const processIsolation = false;
  const importPaths = [setupFiles];
  const absoluteImportPaths = importPaths.map(path => require.resolve(path, {
    paths: [process.cwd()]
  }));

  const processCount = cpus().length;

  if (processIsolation) {
    await runInSeperateProcesses(directories, processCount, absoluteImportPaths);
  } else {
    await runAndRecycleProcesses(directories, processCount, absoluteImportPaths);
  }
};

export default run;