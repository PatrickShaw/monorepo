import { parse, ParserOptions } from '@babel/parser';
import { File, AssignmentExpression, Expression, BaseNode, Statement } from '@babel/types';
import { PartialTestHookOptions } from '@fault/addon-hook-schema';
import * as t from '@babel/types';
import { TesterResults, TestResult, FailingTestData } from '@fault/types';
import { readFile, writeFile, mkdtemp, unlink, rmdir } from 'mz/fs';
import { createCoverageMap } from 'istanbul-lib-coverage';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { ExpressionLocation, Coverage } from '@fault/istanbul-util';
import ErrorStackParser from 'error-stack-parser';
import { reportFaults, Fault, ScorelessFault, recordFaults } from '@fault/record-faults';
import chalk from 'chalk';

import traverse from '@babel/traverse';

export const createAstCache = (babelOptions?: ParserOptions) => {
  const cache = new Map<string, File>();
  return {
    get: async (filePath: string, force: boolean = true): Promise<File> => {
      if (!force && cache.has(filePath)) {
        return cache.get(filePath)!;
      }

      const code = await readFile(filePath, 'utf8');
      const ast = parse(code, babelOptions);
      cache.set(filePath, ast);
      return ast;
    },
  };
};
type AstCache = ReturnType<typeof createAstCache>;

type Mutation = {
  filePath: string;
  location: ExpressionLocation;
  //ast: File
};

type MutationResults = {
  mutations: Mutation[];
};

const assignmentOperations = [
  '=',
  '!=',
  '&=',
  '^=',
  '<<=',
  '>>=',
  '-=',
  '+=',
  '/=',
  '*=',
];
const originalPathToCopyPath: Map<string, string> = new Map();
let copyFileId = 0;
let copyTempDir: string = null!;
const resetFile = async (filePath: string) => {
  const copyPath = originalPathToCopyPath.get(filePath)!;
  const fileContents = await readFile(copyPath, 'utf8');
  await writeFile(filePath, fileContents, 'utf8');
};

const createTempCopyOfFileIfItDoesntExist = async (filePath: string) => {
  if (!originalPathToCopyPath.has(filePath)) {
    const fileContents = await readFile(filePath, 'utf8');
    const fileId = copyFileId++;
    const copyPath = resolve(copyTempDir, fileId.toString());
    originalPathToCopyPath.set(filePath, copyPath);
    await writeFile(copyPath, fileContents);
  }
};

const BLOCK = 'block';
const ASSIGNMENT = 'assignment';
const UNKNOWN = 'unknown';
type IndirectInfo = {
  distance: number,
  mutationEvalation: MutationEvaluation
};
type GenericInstruction = {
  //indirect: IndirectInfo[],
  mutationEvaluations: MutationEvaluation[],
  derivedFromPassingTest: boolean
};


/**
 * From least desirable to be processed to most
 */
const compareInstructions = (a: Instruction, b: Instruction) => {
  a.mutationEvaluations.sort(compareMutationEvaluations);
  b.mutationEvaluations.sort(compareMutationEvaluations);
  let aI = 0;
  let bI = 0;
  while(aI < a.mutationEvaluations.length && bI < a.mutationEvaluations.length) {
    const aMutationEvaluation = a.mutationEvaluations[aI];
    const bMutationEvaluation = b.mutationEvaluations[bI];
    const comparison = compareMutationEvaluations(aMutationEvaluation, bMutationEvaluation);
    if (comparison !== 0) {
      return comparison;
    }
    aI++;
    bI++;
  }
  if (a.mutationEvaluations.length < b.mutationEvaluations.length) {
    return 1;
  } else if (a.mutationEvaluations.length > b.mutationEvaluations.length) {
    return -1;
  }
  return 0;
};

type Location = {
  location: ExpressionLocation;
  filePath: string;
}
type GenericMutationSite = {
  type: string;
} & GenericInstruction & Location;

type AssignmentMutationSite = {
  type: typeof ASSIGNMENT;
  operators: string[];
} & GenericMutationSite;

type BlockMutationSite = {
  type: typeof BLOCK,
  indexes: number[],
} & GenericMutationSite;

type Instruction = AssignmentMutationSite | BlockMutationSite;

const findNodePathsWithLocation = (ast, location: ExpressionLocation) => {
  let nodePaths: any[] = [];
  traverse(ast, {
    enter(path) {
      const loc1 = location;
      const loc2 = path.node.loc!;
      if (
        loc1.start.column === loc2.start.column &&
        loc1.start.line === loc2.start.line &&
        loc1.end.column === loc2.end.column &&
        loc1.end.line === loc2.end.line
      ) {
        nodePaths.push(path);
      }
    },
  });
  return nodePaths;
};

const getParentScope = (path) => {
  const parentPath = path.parentPath;
  if (parentPath) {
    return path;
  }
  const parentNode = parentPath.node;
  if (t.isFunction(parentNode) || t.isProgram(parentNode)) {
    return path;
  }
  return getParentScope(parentPath);
}

const expressionKey = (filePath: string, node: BaseNode) => `${filePath}:${node.loc!.start.line}:${node.loc!.start.column}:${node.loc!.end.line}:${node.loc!.end.column}:${node.type}`;

async function* identifyUnknownInstruction(
  instruction: Location,
  cache: AstCache,
  expressionsSeen: Set<string>,
  derivedFromPassingTest: boolean
): AsyncIterableIterator<Instruction> {
  const ast = await cache.get(instruction.filePath);
  const nodePaths = findNodePathsWithLocation(ast, instruction.location);
  //console.log(nodePaths);
  const filePath = instruction.filePath;
  for(const nodePath of nodePaths) {
    const newInstructions: any[] = [];
    const scopedPath = getParentScope(nodePath);
    console.log(chalk.cyan(scopedPath.type));

    const location = nodePath.node.loc;

    traverse(scopedPath.node, {
      enter: (path) => {
        const pathNode = path.node;
        console.log(path.type);
        const key = expressionKey(filePath, pathNode);
        if (expressionsSeen.has(key)) {
          return;
        }
        expressionsSeen.add(key);
        if (t.isAssignmentExpression(pathNode)) {
          newInstructions.push({
            type: ASSIGNMENT,
            operators: [...assignmentOperations].filter(
              operator => operator !== pathNode.operator,
            ),
            derivedFromPassingTest,
            filePath,
            location,
          });
        } else if(t.isBlockStatement(pathNode)) {
          newInstructions.push({
            type: BLOCK,
            indexes: pathNode.body.map((statement, i) => i),
            derivedFromPassingTest,
            location,
            filePath
          });
        }    
      }
    }, scopedPath.scope);
    newInstructions.forEach(console.log);

    yield* newInstructions;
  }
};

const processAssignmentInstruction = async (
  instruction: AssignmentMutationSite,
  cache: AstCache,
  client: Client
): Promise<MutationResults | null> => {
  const ast = await cache.get(instruction.filePath);

  const nodePaths = findNodePathsWithLocation(ast, instruction.location);
  if (nodePaths.length <= 0) {
    return null;
  }
  if (instruction.operators.length <= 0) {
    return null;
  }

  client.addInstruction(instruction);

  const operators = instruction.operators.pop();
  const nodePath = nodePaths[0];
  nodePath.node.operator = operators;
  return {
    mutations: [
      {
        filePath: instruction.filePath,
        location: instruction.location,
      },
    ],
  };
};

const processBlockInstruction = async (
  instruction: BlockMutationSite,
  cache: AstCache,
  client: Client
): Promise<MutationResults | null> => {
  const ast = await cache.get(instruction.filePath);
  
  const nodePaths = findNodePathsWithLocation(ast, instruction.location).filter(thePath => t.isBlockStatement(thePath.node));
  if (nodePaths.length <= 0) {
    return null;
  }

  if (instruction.indexes.length <= 0) {
    return null;
  }

  client.addInstruction(instruction);

  const index = instruction.indexes.pop();

  const nodePath = nodePaths.pop()!;

  console.log(nodePath);
  nodePath.node.body.splice(index, 1);

  return {
    mutations: [
      {
        filePath: instruction.filePath,
        location: instruction.location,
      }
    ]
  }
};

type Client = {
  addInstruction(instruction: Instruction);
}
const processInstruction = async (
  instruction: Instruction,
  cache: AstCache,
  client: Client
): Promise<MutationResults | null> => {
  switch (instruction.type) {
    case ASSIGNMENT:
      return processAssignmentInstruction(instruction, cache, client);
    case BLOCK:
      return processBlockInstruction(instruction, cache, client);
    default:
      throw new Error(`Unknown instruction type: ${(instruction as any).type}`);
  }
};

export type TestEvaluation = {
  // Whether the exception that was thrown in the test has changed
  errorChanged: boolean;
  // How much better we're doing in terms of whether the test failed/passed
  endResultImprovement: number;
} & StackEvaluation;

type StackEvaluation = {
  stackColumnScore: number | null;
  stackLineScore: number | null;
};

/**
 * From worst evaluation to best evaluation
 */
export const compareMutationEvaluations = (
  result1: MutationEvaluation,
  result2: MutationEvaluation,
) => {
  const testsWorsened = result2.testsWorsened - result1.testsWorsened;
  if (testsWorsened !== 0) {
    return testsWorsened;
  }

  const testsImproved = result1.testsImproved - result2.testsImproved;
  if (testsImproved !== 0) {
    return testsImproved;
  }

  const lineDegradationScore =
    result2.lineDegradationScore - result1.lineDegradationScore;
  if (lineDegradationScore !== 0) {
    return lineDegradationScore;
  }

  const columnDegradationScore =
    result2.columnDegradationScore - result1.columnDegradationScore;
  if (columnDegradationScore !== 0) {
    return columnDegradationScore;
  }

  const lineScoreNulls = result2.lineScoreNulls - result1.lineScoreNulls;
  if (lineScoreNulls !== 0) {
    return lineScoreNulls;
  }

  const columnScoreNulls = result2.columnScoreNulls - result2.columnScoreNulls;
  if (columnScoreNulls !== 0) {
    return columnScoreNulls;
  }

  const lineImprovementScore =
    result1.lineImprovementScore - result2.lineImprovementScore;
  if (lineImprovementScore !== 0) {
    return lineImprovementScore;
  }

  const columnImprovementScore =
    result1.columnImprovementScore - result2.columnImprovementScore;
  if (columnImprovementScore !== 0) {
    return columnImprovementScore;
  }

  const errorsChanged = result1.errorsChanged - result2.errorsChanged;
  if (errorsChanged !== 0) {
    return errorsChanged;
  }
  return 0;
};

export const evaluateStackDifference = (
  originalResult: TestResult,
  newResult: TestResult,
): StackEvaluation => {
  console.log(newResult);
  console.log(chalk.cyan('new result stack'))
  console.log(newResult.stack);
  console.log(chalk.cyan('old result stack'))
  console.log(originalResult.stack);
  if (newResult.stack == null || originalResult.stack == null) {
    return {
      stackColumnScore: null,
      stackLineScore: null,
    };
  }
  const newStackInfo = ErrorStackParser.parse({ stack: newResult.stack });
  const oldStackInfo = ErrorStackParser.parse({ stack: originalResult.stack });

  const firstNewStackFrame = newStackInfo[0];
  const firstOldStackFrame = oldStackInfo[0];

  if (firstNewStackFrame.fileName !== firstOldStackFrame.fileName) {
    return {
      stackColumnScore: null,
      stackLineScore: null,
    };
  }
  const stackLineScore =
    firstNewStackFrame.lineNumber !== undefined &&
    firstOldStackFrame.lineNumber !== undefined
      ? firstNewStackFrame.lineNumber - firstOldStackFrame.lineNumber
      : null;
  const stackColumnScore =
    firstNewStackFrame.columnNumber !== undefined &&
    firstOldStackFrame.columnNumber !== undefined
      ? firstNewStackFrame.columnNumber - firstOldStackFrame.columnNumber
      : null;

  return { stackColumnScore, stackLineScore };
};

const EndResult = {
  BETTER: 1,
  UNCHANGED: 0,
  WORSE: -1,
};

export const evaluateModifiedTestResult = (
  originalResult: TestResult,
  newResult: TestResult,
): TestEvaluation => {
  const samePassFailResult = originalResult.passed === newResult.passed;
  const endResultImprovement: number = samePassFailResult
    ? EndResult.WORSE
    : newResult.passed
    ? EndResult.BETTER
    : EndResult.WORSE;
  const errorChanged: boolean = (() => {
    if (!samePassFailResult) {
      return true;
    }
    if (newResult.passed) {
      return false;
    }
    return newResult.stack === (originalResult as FailingTestData).stack;
  })();
  const stackEvaluation = evaluateStackDifference(originalResult, newResult);

  return {
    endResultImprovement,
    errorChanged,
    ...stackEvaluation,
  };
};

type MutationEvaluation = {
  mutations: Mutation[];
  testsWorsened: number;
  testsImproved: number;
  lineDegradationScore: number;
  columnDegradationScore: number;
  lineScoreNulls: number;
  columnScoreNulls: number;
  lineImprovementScore: number;
  columnImprovementScore: number;
  errorsChanged: number;
};
const evaluateNewMutation = (
  originalResults: TesterResults,
  newResults: TesterResults,
  mutationResults: MutationResults,
): MutationEvaluation => {
  const notSeen = new Set(originalResults.testResults.keys());
  let testsWorsened = 0;
  let testsImproved = 0;
  let lineDegradationScore = 0;
  let columnDegradationScore = 0;
  let lineImprovementScore = 0;
  let lineScoreNulls = 0;
  let columnImprovementScore = 0;
  let columnScoreNulls = 0;
  let errorsChanged = 0;

  for (const [key, newResult] of newResults.testResults) {
    if (!notSeen.has(key)) {
      // Maybe don't
      continue;
    }
    notSeen.delete(key);
    const oldResult = originalResults.testResults.get(key);
    if (oldResult === undefined) {
      // Maybe don't
      continue;
    }
    const testEvaluation = evaluateModifiedTestResult(oldResult, newResult);

    // End result scores
    if (testEvaluation.endResultImprovement === EndResult.BETTER) {
      testsImproved++;
    } else if (testEvaluation.endResultImprovement === EndResult.WORSE) {
      testsWorsened++;
    } else if (testEvaluation.errorChanged) {
      errorsChanged++;
    }

    // Stack scores
    if (testEvaluation.stackLineScore === null) {
      lineScoreNulls++;
    } else if (testEvaluation.stackLineScore > 0) {
      lineImprovementScore += testEvaluation.stackLineScore;
    } else if (testEvaluation.stackLineScore < 0) {
      lineDegradationScore -= testEvaluation.stackLineScore;
    } else if (testEvaluation.stackColumnScore === null) {
      columnScoreNulls++;
    } else if (testEvaluation.stackColumnScore > 0) {
      columnImprovementScore += testEvaluation.stackColumnScore;
    } else if (testEvaluation.stackColumnScore < 0) {
      columnImprovementScore -= testEvaluation.stackColumnScore;
    }
  }
  return {
    mutations: mutationResults.mutations,
    testsWorsened,
    testsImproved,
    lineDegradationScore,
    columnDegradationScore,
    lineScoreNulls,
    columnScoreNulls,
    lineImprovementScore,
    columnImprovementScore,
    errorsChanged,
  };
};

type LocationKey = string;

const locationToKey = (filePath: string, location: ExpressionLocation) => {
  return `${filePath}:${location.start.line}:${location.start.column}`;
};

export const mutationEvalatuationMapToFaults = (
  evaluations: MutationEvaluation[],
): Fault[] => {
  const sortedEvaluationsLists = evaluations.sort(compareMutationEvaluations);
  const seen: Set<string> = new Set();
  const faults: ScorelessFault[] = [];
  for (const evaluation of sortedEvaluationsLists) {
    for (const mutation of evaluation.mutations) {
      const key = locationToKey(mutation.filePath, mutation.location);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      faults.push({
        sourcePath: mutation.filePath,
        location: mutation.location,
      });
    }
  }

  return faults.map((fault, i) => ({
    ...fault,
    score: faults.length - i
  }));
};

export type PluginOptions = {
  faultFilePath?: string,
  babelOptions?: ParserOptions,
  mutationThreshold?: number,
  durationThreshold?: number,
};

type FinishOptions = {
  
};

export const createPlugin = ({
  faultFilePath = './faults/faults.json',
  babelOptions,
  durationThreshold,
  mutationThreshold,
}: PluginOptions): PartialTestHookOptions => {
  let previousMutationResults: MutationResults | null = null;
  const instructionQueue: Instruction[] = [];
  let firstRun = true;
  let firstTesterResults: TesterResults;
  const evaluations: MutationEvaluation[] = [];
  const expressionsSeen: Set<string> = new Set();
  let mutationCount = 0;

  const client = {
    addInstruction: (instruction) => {
      instructionQueue.push(instruction);
    }
  };
  return {
    on: {
      start: async () => {
        // TODO: Types appear to be broken with mkdtemp
        copyTempDir = await (mkdtemp as any)(join(tmpdir(), 'fault-addon-mutation-localization-'));
      },
      allFilesFinished: async (tester: TesterResults) => {
        console.log('finished all files')
        const cache = createAstCache(babelOptions);
        if (firstRun) {
          firstTesterResults = tester;
          firstRun = false;
          const passedCoverageMap = createCoverageMap({});
          const failedCoverageMap = createCoverageMap({});
          for (const testResult of tester.testResults.values()) {
            // TODO: Maybe don't?
            if (testResult.passed) {
              passedCoverageMap.merge(testResult.coverage);
            } else {
              failedCoverageMap.merge(testResult.coverage);
            }
          }
          const coverageSeen: Set<string> = new Set();
          const passedCoverage: Coverage = passedCoverageMap.data;
          const failedCoverage: Coverage = failedCoverageMap.data;
          for(const [coveragePath, fileCoverage] of Object.entries(failedCoverage)) {
            for(const [key, statementCoverage] of Object.entries(fileCoverage.statementMap)) {
              coverageSeen.add(locationToKey(coveragePath, statementCoverage));
              for await (const instruction of identifyUnknownInstruction({
                location: statementCoverage,
                filePath: coveragePath,
              }, cache, expressionsSeen, true)) {
                instructionQueue.push(instruction);
              }
            }
          }
          for (const [coveragePath, fileCoverage] of Object.entries(
            passedCoverage as Coverage,
          )) {
            for (const [key, statementCoverage] of Object.entries(
              fileCoverage.statementMap,
            )) {
              if (coverageSeen.has(locationToKey(coveragePath, statementCoverage))) {
                continue;
              }
              for await (const instruction of identifyUnknownInstruction({
                location: statementCoverage,
                filePath: coveragePath,
              }, cache, expressionsSeen, true)) {
                instructionQueue.push(instruction);
              }
            }
          }
        } else {
          // TODO: Can't remember if previousMutationResults should never be null or not here :P
          const mutationEvaluation = evaluateNewMutation(
            firstTesterResults,
            tester,
            previousMutationResults!,
          );
          evaluations.push(mutationEvaluation);
        }

        if (previousMutationResults !== null) {
          for (const mutation of previousMutationResults.mutations) {
            await resetFile(mutation.filePath);
          }
        }

        if (durationThreshold !== undefined && tester.duration >= durationThreshold) {
          return;
        }

        if(mutationThreshold !== undefined && mutationCount >= mutationThreshold) {
          return;
        }

        let instruction = instructionQueue.pop();

        instructionQueue.sort(compareInstructions);
        console.log('processing')
        
        let mutationResults: any = null;
        while (instruction !== undefined && (mutationResults === null || mutationResults.mutations.length <= 0)) {
          mutationResults = await processInstruction(instruction, cache, client);
          instruction = instructionQueue.pop();
        }
        
        console.log('processed');

        if (mutationResults === null || mutationResults.mutations.length <=0) {
          console.log('ending');
          return;
        }

        mutationCount++;
        
        await Promise.all(
          mutationResults.mutations.map(mutation =>
            createTempCopyOfFileIfItDoesntExist(mutation.filePath),
          ),
        );

        previousMutationResults = mutationResults;
        const testsToBeRerun = [...tester.testResults.values()].map(result => result.file);
        console.log('done')

        return testsToBeRerun;
      },
      complete: async () => {
        console.log('complete');
        await Promise.all(
          [...originalPathToCopyPath.values()].map(copyPath => unlink(copyPath)),
        );
        await rmdir(copyTempDir);
        const faults = mutationEvalatuationMapToFaults(evaluations);
        await recordFaults(faultFilePath, faults);
        await reportFaults(faults);
      },
    },
  };
};

export default createPlugin;