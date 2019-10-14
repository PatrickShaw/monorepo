import { parse, ParserOptions } from '@babel/parser';
import { File, AssignmentExpression, Expression, BaseNode, Statement } from '@babel/types';
import { PartialTestHookOptions } from '@fault/addon-hook-schema';
import * as t from '@babel/types';
import { TesterResults, TestResult, FailingTestData, FinalTesterResults } from '@fault/types';
import { readFile, writeFile, mkdtemp, unlink, rmdir } from 'mz/fs';
import { createCoverageMap } from 'istanbul-lib-coverage';
import { join, resolve, basename } from 'path';
import { tmpdir } from 'os';
import { ExpressionLocation, Coverage } from '@fault/istanbul-util';
import ErrorStackParser from 'error-stack-parser';
import { NodePath } from '@babel/traverse';
import { reportFaults, Fault, ScorelessFault, recordFaults } from '@fault/record-faults';
import generate from '@babel/generator';
import chalk from 'chalk';
import * as micromatch from 'micromatch';
import Heap from '@pshaw/binary-heap';
import traverse from '@babel/traverse';

export const createAstCache = (babelOptions?: ParserOptions) => {
  const cache = new Map<string, File>();
  return {
    get: async (filePath: string, force: boolean = false): Promise<File> => {
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

type LocationObject = {
  [filePath: string]: ExpressionLocation[]
};

type MutationResults = {
  lineWidth: number,
  columnWidth: number,
  locations: LocationObject
};

const totalMutations = (mutationResults: MutationResults) => {
  let count = 0;
  for(const location of Object.values(mutationResults.locations)) {
    count += location.length;
  }
  return count;
}

const originalPathToCopyPath: Map<string, string> = new Map();
let copyFileId = 0;
let copyTempDir: string = null!;
const resetFile = async (filePath: string) => {
  const copyPath = await originalPathToCopyPath.get(filePath)!;
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

/**
 * From least desirable to be processed to most
 */
const compareInstructions = (a: InstructionHolder, b: InstructionHolder) => {
  // TODO: The most important instructions should be ones that have huge potential to be a fix (E.g. Only improves tests, nothing else)
  if (a.data.derivedFromPassingTest && !b.data.derivedFromPassingTest) {
    return -1;
  } else if(!a.data.derivedFromPassingTest && b.data.derivedFromPassingTest) {
    return 1;
  }
  a.data.mutationEvaluations.sort(compareMutationEvaluations);
  b.data.mutationEvaluations.sort(compareMutationEvaluations);
  let aI = a.data.mutationEvaluations.length - 1;
  let bI = b.data.mutationEvaluations.length - 1;
  while(aI >= 0 && bI >= 0) {
    const aMutationEvaluation = a.data.mutationEvaluations[aI];
    const bMutationEvaluation = b.data.mutationEvaluations[bI];
    const comparison = compareMutationEvaluations(aMutationEvaluation, bMutationEvaluation);
    if (comparison !== 0) {
      return comparison;
    }
    aI--;
    bI--;
  }
  while(aI >= 0) {
    const aMutationEvaluation = a.data.mutationEvaluations[aI];
    const didSomethingGoodOrCrashed = evaluationDidSomethingGoodOrCrashed(aMutationEvaluation);
    if (didSomethingGoodOrCrashed) {
      return 1;
    }
    aI--;
  }
  while(bI >= 0) {
    const bMutationEvaluation = b.data.mutationEvaluations[bI];
    const didSomethingGoodOrCrashed = evaluationDidSomethingGoodOrCrashed(bMutationEvaluation);
    if (didSomethingGoodOrCrashed) {
      return -1;
    }
    bI--;
  }
  return b.data.mutationEvaluations.length - a.data.mutationEvaluations.length;
};

type Location = {
  filePath: string;
} & ExpressionLocation;

type StatementInformation = {
  index: any,
  filePath: string,
  location: ExpressionLocation,
  retries: number,
  innerStatements: StatementInformation[],
  instructionHolders: InstructionHolder[],
  totalNodes: number,
}

type InstructionData = {
  mutationEvaluations: MutationEvaluation[],
  derivedFromPassingTest: boolean,
};

type Instruction = {
  type: Symbol;
  isRemovable: (evaluation: MutationEvaluation, data: InstructionData) => boolean,
  mutationResults: MutationResults,
  process: (data: InstructionData, cache: AstCache) => Promise<any>,
  totalNodes: number,
  atomicMutation: boolean,
  mutationsLeft: number,
  onEvaluation: (evaluation: MutationEvaluation, data: InstructionData, cache: AstCache) => AsyncIterableIterator<InstructionHolder<any>>
}

type InstructionHolder<T extends Instruction = Instruction> = {
  data: InstructionData,
  instruction: T,
};


type InstructionFactory<T extends Instruction = Instruction> = {
  onInitialPass(nodePath: NodePath, filePath: string, derivedFromPassingTest: boolean);
  createPreBlockInstructions(nodePath: NodePath, filePath: string, derivedFromPassingTests: boolean);
  createInstructions(nodePath: NodePath, filePath: string, derivedFromPassingTest: boolean): IterableIterator<InstructionHolder<T>>;
};

const createInstructionHolder = <T extends Instruction>(
  instruction: T,
  derivedFromPassingTest: boolean
): InstructionHolder<T> => {
  return {
    data: {
      mutationEvaluations: [],
      derivedFromPassingTest,
    },
    instruction,
  }
}

const findNodePathsWithLocation = (ast: t.File, location: ExpressionLocation) => {
  let nodePaths: NodePath[] = [];
  traverse(ast, {
    enter(path) {
      const loc1 = location;
      const loc2 = path.node.loc;
      if (
        loc2 &&
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

const getParentScope = (path: NodePath<t.Node>): (NodePath<t.Scopable> | NodePath<t.Node>) => {
  const parentPath = path.parentPath;
  if (!parentPath) {
    return path;
  }
  if (isStatementContainer(parentPath)) {
    return parentPath as NodePath<t.Scopable>;
  }
  return getParentScope(parentPath);
}

const expressionKey = (filePath: string, node: BaseNode) => `${filePath}:${node.loc!.start.line}:${node.loc!.start.column}:${node.loc!.end.line}:${node.loc!.end.column}:${node.type}`;

const assertFoundNodePaths = (nodePaths: any[], location: Location) => {
  if (nodePaths.length <= 0) {
    throw new Error(`Expected to find a node at location ${locationToKeyIncludingEnd(location.filePath, location)} but didn't`);
  }
};

const OPERATOR = Symbol('operation');
export const binaryOperationCategories = [
  [['&', '&&']], [['|', '||']], ['^', ['&', '>>>', '>>'], ['|', '<<']] ,[['&&', '||'], [['>=', '>'], ['<=', '<']], [['!=', '=='], ['!==', '===']]], ['**', '%', ['/', '*'], ['-', '+']]
];

abstract class SingleLocationInstruction implements Instruction {
  public abstract type: Symbol;  
  public readonly mutationCount = 1
  private readonly retryHandler = new RetryHandler();
  public readonly mutationResults: MutationResults;
  public readonly atomicMutation: boolean = true;
  constructor(private readonly location: Location) {
    this.mutationResults = locationToMutationResults(location);
  }

  isRemovable(evaluation: MutationEvaluation) {
    return this.retryHandler.evaluate(evaluation);
  }

  protected abstract processNodePaths(nodePaths: NodePath[]);

  abstract filterNodePath(nodePath: NodePath): boolean;

  async process(data, cache) {
    const ast = await cache.get(this.location.filePath);

    const nodePaths = findNodePathsWithLocation(ast, this.location).filter(nodePath => this.filterNodePath(nodePath));
    assertFoundNodePaths(nodePaths, this.location);

    this.processNodePaths(nodePaths);
  }
}

class BinaryInstruction extends SingleLocationInstruction {
  public readonly type: Symbol = OPERATOR;
  public readonly mutationCount = 1;

  filterNodePath(nodePath) {
    return nodePath.isBinaryExpression() || nodePath.isLogicalExpression();
  }

  constructor(
    location: Location,
    private readonly operators: string[],
    public readonly totalNodes: number
  ) {
    super(location);
  }

  isRemovable(evaluation) {
    return this.operators.length <= 0 || super.isRemovable(evaluation);    
  }

  get mutationsLeft() {
    return this.operators.length;
  }

  async processNodePaths(nodePaths) {
    const operator = this.operators.pop()!;
    const nodePath = nodePaths[0];

    const node = nodePath.node as (t.BinaryExpression | t.LogicalExpression);

    if (['||', '&&'].includes(operator)) {
      nodePath.replaceWith(t.logicalExpression(operator as any, node.left, node.right));
    } else {
      nodePath.replaceWith(t.binaryExpression(operator as any, node.left, node.right));
    }
    
    node.operator = operator as any;  
  }

  async *onEvaluation() {}
}

const locationToMutationResults = (location: Location) => {
  return {
    lineWidth: location.end.line - location.start.line,
    columnWidth: location.end.column - location.start.column,
    locations: {
      [location.filePath]: [location]        
    }
  }
}

const ASSIGNMENT = Symbol('assignment');
class AssignmentInstruction extends SingleLocationInstruction {
  public readonly type: Symbol = ASSIGNMENT;
  constructor(
    location: Location,
    private readonly operators: string[],
    public readonly totalNodes: number,
  ) {
    super(location);
  }

  isRemovable(evaluation) {
    return this.operators.length <= 0 || super.isRemovable(evaluation);
  }

  get mutationsLeft() {
    return this.operators.length;
  }

  filterNodePath(nodePath) {
    return nodePath.isAssignmentExpression();
  }

  processNodePaths(nodePaths) {
    const operator = this.operators.pop();
    const nodePath = nodePaths[0];

    nodePath.node.operator = operator;  
  }

  async *onEvaluation() {}
}

const didSomethingGood = (evaluation: MutationEvaluation) => {
  return !evaluation.crashed && (evaluation.testsImproved > 0 || evaluation.errorsChanged > 0 || !nothingChangedMutationStackEvaluation(evaluation.stackEvaluation)); 
}
const evaluationDidSomethingGoodOrCrashed = (evaluation: MutationEvaluation) => {
  return evaluation.crashed || didSomethingGood(evaluation);
}

const evaluationDidNothingBad = (evaluation: MutationEvaluation) => {
  return evaluation.testsWorsened === 0 && evaluation.stackEvaluation.lineDegradationScore === 0 && evaluation.stackEvaluation.columnDegradationScore === 0;
}

type StatementBlock = { 
  statements: StatementInformation[],
}
const DELETE_STATEMENT = Symbol('delete-statement');
class DeleteStatementInstruction implements Instruction {
  public readonly type = DELETE_STATEMENT;
  public mutationResults: MutationResults;
  public mutationsLeft: number;
  public totalNodes: number;
  public atomicMutation: boolean;
  private lastProcessedStatementBlock: StatementBlock= undefined!;
  private statementBlocks: Heap<StatementBlock>; 
  constructor(
    statements: StatementBlock[],
    private readonly maxRetries: number,
  ) {
    this.statementBlocks = new Heap((a, b) => a.statements.length - b.statements.length, statements);
    // TODO: This doesn't really make sense, need to make this less hacky
    this.lastProcessedStatementBlock = this.statementBlocks.peek();
    this.recalculateMutationResults();
  }

  /**
   * Managing state like this is gross, refactor
   */
  recalculateMutationResults() {
    const locationsObj: LocationObject = {};
    const locationsAdded: Set<string> = new Set();
    const statements = this.lastProcessedStatementBlock.statements;
    this.atomicMutation = statements.length <= 1;
    const stack: StatementInformation[] = [...statements];
    let totalNodes = 0;
    for(const outerStatement of statements) {
      totalNodes += outerStatement.totalNodes;
    }
    this.totalNodes = totalNodes;
    let s = 0;
    while (s < stack.length) {
      const statement = stack[s];
      const key = locationToKeyIncludingEnd(statement.filePath, statement.location!);
      if(statement.innerStatements.length > 0) {
        stack.push(...statement.innerStatements);
      }
      if (!locationsAdded.has(key)) {
        if(locationsObj[statement.filePath] === undefined) {
          locationsObj[statement.filePath] = [];
        }
        locationsObj[statement.filePath].push(statement.location);
        locationsAdded.add(key);
      }
      s++;
    }
    let lineWidth = 0;
    let columnWidth = 0;
    for(const statement of statements) {
      lineWidth += Math.abs(statement.location.end.line - statement.location.start.line);
      columnWidth += Math.abs(statement.location.end.column - statement.location.start.column);
    }
    this.mutationResults = {
      lineWidth,
      columnWidth,
      locations: locationsObj
    };

    let count = statements.length * 2 - 1;
    for(const statement of statements) {
      for(const instructionHolder of statement.instructionHolders) {
        count += instructionHolder.instruction.mutationsLeft;
      }
    }
    this.mutationsLeft = count;
  }

  isRemovable() {
    return this.statementBlocks.length <= 0;
  }

  async process(data: InstructionData, cache: AstCache) {  
    const statements = this.statementBlocks.pop()!;
    this.lastProcessedStatementBlock = statements;
    this.recalculateMutationResults();
    console.log(`${statements.statements.length} left in statement & ${this.statementBlocks.length + 1} blocks left`);
    const sortedStatements = [...statements.statements].sort((a, b) => {
      const comparison = a.filePath.localeCompare(b.filePath);
      if (comparison !== 0) {
        return comparison;
      }
    
      const startLine = a.location.start.line - b.location.start.line;
      if (startLine !== 0) {
        return startLine;
      }
      const startColumn = a.location.start.column - b.location.start.column;
      if (startColumn !== 0) {
        return startColumn;
      }
      const endLine = a.location.end.line - b.location.end.line;
      if (endLine !== 0) {
        return endLine;
      }
      const endColumn = a.location.end.column - b.location.end.column;
      if (endColumn !== 0) {
        return endColumn;
      }
      return 0;
    })
    // TODO: Really shouldn't have to rely on the order of statements for this to work
    for(let s = sortedStatements.length - 1; s >= 0; s--) {
      const statement = sortedStatements[s];
      const ast = await cache.get(statement.filePath);
      const nodePaths = findNodePathsWithLocation(ast, statement.location!);
      assertFoundNodePaths(nodePaths, { ...statement.location!, filePath: statement.filePath });
      const filteredNodePaths = nodePaths.filter(path => path.parentPath && (path.parentPath.node.body || path.parentPath.node.consequent));
      assertFoundNodePaths(filteredNodePaths, { ...statement.location!, filePath: statement.filePath });
      // TODO: Pretty sure you'll only ever get 1 node path but should probably check to make sure
      const path = filteredNodePaths.pop()!;
      const node = path.node;
      const parentPath = path.parentPath;
      const parentNode = parentPath!.node;
      console.log(`${locationToKeyIncludingEnd(statement.filePath, statement.location)}`,statement.index,  parentNode.type, node.type);
      if(parentPath.isIfStatement()) {
        parentNode[path.key] = t.blockStatement([]);
      } else if(Array.isArray(parentNode.body)) {
        parentNode.body.splice(statement.index, 1);
      } else {
        parentNode.body = t.blockStatement([]);
      }
    }
  }

  private splitStatementBlock(statements: StatementInformation[]) {
    const middle = Math.trunc(statements.length / 2);
    const statements1 = statements.slice(middle);
    const statements2 = statements.slice(0, middle);
    this.statementBlocks.push({
      statements: statements1,
    });
    this.statementBlocks.push({
      statements: statements2,
    });
  }

  mergeStatementsWithLargestStatementBlock(statements: StatementInformation[]) {
    if (this.statementBlocks.length <= 0) {
      this.statementBlocks.push({
        statements,
      });
      return;
    }
    let largestStatementBlock: StatementBlock | null = null;
    for(const statementBlock of this.statementBlocks.unsortedIterator()) {
      if(statementBlock.statements[0].retries < this.maxRetries) {
        if (largestStatementBlock === null || statementBlock.statements.length > largestStatementBlock.statements.length) {
          largestStatementBlock = statementBlock;
        }  
      }
    }
    if (largestStatementBlock !== null) {
      largestStatementBlock.statements.push(...statements);
      this.statementBlocks.update(largestStatementBlock);  
    }
  }

  async *onEvaluation(evaluation: MutationEvaluation): AsyncIterableIterator<InstructionHolder> {
    const statements = this.lastProcessedStatementBlock;
    if (statements.statements.length <= 0) {
      throw new Error(`There were ${statements.statements.length} statements`);
    }
 
    const deletingStatementsDidSomethingGoodOrCrashed = evaluationDidSomethingGoodOrCrashed(evaluation);
    if (deletingStatementsDidSomethingGoodOrCrashed) {
      if (!evaluation.crashed) {
        for(const statement of statements.statements) {
          statement.retries = this.maxRetries;
        }  
      }
      if (statements.statements.length === 1) {
        const statement = statements.statements[0];
        yield* statement.instructionHolders;
      } else {
        this.splitStatementBlock(statements.statements);
      }
    } else {
      for(let s = statements.statements.length - 1; s >= 0; s--) {
        const statement = statements.statements[s];
        if(statement.retries <= 0) {
          statements.statements.splice(s, 1);
        } else {
          statement.retries--;
        }
      }
      if (statements.statements.length > 1) {
        this.splitStatementBlock(statements.statements);
      }
    }
  }
}

class RetryHandler {
  private readonly maxRetries: number = RETRIES;
  private retries: number = this.maxRetries;

  /**
   * @param evaluation The mutation evaluation
   * @returns whether the instruction needs to be removed or not
   */
  evaluate(evaluation): boolean {
    if (!didSomethingGood(evaluation)) {
      if (this.retries > 0) {
        this.retries--;
      } else {
        return true;
      }
    } else {
      this.retries = this.maxRetries;
    }
    return false;
  }
}

interface CategoryData<T> extends Array<T | CategoryData<T>> {};
const recursiveIncludes = (match: any, arr: any) => {
  if (match === arr) {
    return true;
  } else if (Array.isArray(arr)) {
    return arr.some(item => recursiveIncludes(match, item));
  }
}
/**
 * Creates the ordering for the operation and assignment arrays based off what the 
 * current value of the assignment/operation node is
 */
export const matchAndFlattenCategoryData = <T>(match: T, categories: CategoryData<T>) => {
  const stack: (CategoryData<T> | T)[] = [categories];
  const flattened: T[] = [];
  let s = 0;
  while(s < stack.length) {
    const value = stack[s];
    if (Array.isArray(value)) {
      // Could probably not constantly recursively check if the value is in the array
      // Also constantly pushing new elements onto the stack results in some nasty memory complexity
      if (recursiveIncludes(match, value)) {
        stack.push(...value);
        s++;
      } else {
        stack.splice(s, 1, ...value);
      }
    } else {
      if(match !== value) {
        flattened.push(value as T);
      }
      s++;
    }
  }
  const alreadyAddedSet = new Set();
  return flattened.reverse().filter(item => {
    if (alreadyAddedSet.has(item)) {
      return false;
    } else {
      alreadyAddedSet.add(item);
      return true;
    }
  }).reverse();
};

const REPLACE_STRING = Symbol('replace-string');
class ReplaceStringInstruction extends SingleLocationInstruction {
  public readonly type: Symbol = REPLACE_STRING;
  public readonly mutationsLeft: number = 1;

  constructor(location: Location, private readonly values: string[], public readonly totalNodes: number) {
    super(location);
  }

  filterNodePath(nodePath) {
    if (nodePath.isStringLiteral()) {
      return true;
    }
    return false;
  }

  isRemovable(evaluation) {
    return this.values.length <= 0 || super.isRemovable(evaluation);
  }

  processNodePaths(nodePaths) {
    const nodePath = nodePaths[0];
    const node = nodePath.node;
    node.value = this.values.pop();
  }

  async *onEvaluation() {}
}

const REPLACE_NUMBER = Symbol('replace-number');
class ReplaceNumberInstruction extends SingleLocationInstruction {
  public readonly type: Symbol = REPLACE_NUMBER;
  public readonly mutationsLeft: number = 1;

  constructor(location: Location, private readonly values: number[], public readonly totalNodes: number) {
    super(location);
  }

  filterNodePath(nodePath) {
    return nodePath.isNumericLiteral();
  }

  isRemovable(evaluation) {
    return this.values.length <= 0 || super.isRemovable(evaluation);
  }

  processNodePaths(nodePaths) {
    const nodePath = nodePaths[0] as NodePath<t.NumberLiteral>;

    const node = nodePath.node;
    node.value = this.values.pop()!;
  }

  async *onEvaluation() {}
}

class ReplaceNumberFactory implements InstructionFactory<ReplaceNumberInstruction> {
  private readonly filePathToNumberValues: Map<string, Set<number>> = new Map();

  onInitialPass(nodePath: NodePath, filePath: string) {
    if(nodePath.isNumericLiteral()) {
      if (!this.filePathToNumberValues.has(filePath)) {
        this.filePathToNumberValues.set(filePath, new Set());
      }
      this.filePathToNumberValues.get(filePath)!.add(nodePath.node.value);
    }
  }

  *createPreBlockInstructions() {

  }

  *createInstructions(nodePath, filePath, derivedFromPassingTest) {
    const node = nodePath.node;
    if(nodePath.isNumericLiteral() && node.loc) {
      const values = [...new Set([...this.filePathToNumberValues.get(filePath)!, node.value - 1, node.value + 1])]
        .filter(value => value !== node.value)
        .sort((a, b) => Math.abs(b - node.value) - Math.abs(a - node.value));
      yield createInstructionHolder(new ReplaceNumberInstruction({ ...node.loc, filePath }, values, node[TOTAL_NODES]), derivedFromPassingTest);
    }
  }
}

class ReplaceStringFactory implements InstructionFactory<ReplaceStringInstruction> {
  private readonly filePathToStringValues: Map<string, Set<string>> = new Map();

  onInitialPass(nodePath, filePath: string) {
    if(nodePath.isStringLiteral()) {
      if (!this.filePathToStringValues.has(filePath)) {
        this.filePathToStringValues.set(filePath, new Set());
      }
      this.filePathToStringValues.get(filePath)!.add(nodePath.value);
    }
  }

  *createPreBlockInstructions() {

  }

  *createInstructions(nodePath, filePath, derivedFromPassingTest) {
    const node = nodePath.node;
    if(nodePath.isStringLiteral() && node.loc) {
      const values = [...this.filePathToStringValues.get(filePath)!].filter(value => value !== node.value);
      if(values.length > 0) {
        yield createInstructionHolder(new ReplaceStringInstruction({ ...node.loc, filePath }, values), derivedFromPassingTest);
      }
    }
  }
}

const REPLACE_BOOLEAN = Symbol('replace-boolean');
class InvertBooleanLiteralInstruction extends SingleLocationInstruction {
	public readonly mutationsLeft: number = 1;
  public readonly type = REPLACE_BOOLEAN;
	constructor(location: Location, public readonly totalNodes: number) {
    super(location);
	}

	isRemovable() {
		return true;
  }
  
  filterNodePath(path: NodePath) {
    return path.isBooleanLiteral();
  }
  
  async processNodePaths(nodePaths) {
    const nodePath = nodePaths[0] as NodePath<t.BooleanLiteral>;
    nodePath.node.value = !nodePath.node.value;
  }
	
	async *onEvaluation() {
	}
}

const SWAP_FUNCTION_CALL = Symbol('swap-function-call');
class SwapFunctionCallArgumentsInstruction implements Instruction {
  public readonly type: Symbol = SWAP_FUNCTION_CALL;
  public readonly mutationsLeft = 1;
  public readonly mutationResults: MutationResults;
  public readonly atomicMutation: boolean = true;

  isRemovable() {
    return true;
  }

  constructor(
    private readonly location: Location,
    private readonly arg1: SwapFunctionInformation,
    private readonly arg2: SwapFunctionInformation,
    public readonly totalNodes: number,
  ) {
    let columnWidth = 0;
    columnWidth += arg1.location.end.column - arg1.location.start.column;
    columnWidth += arg2.location.end.column - arg2.location.start.column;

    let lineWidth = 0;
    lineWidth += arg1.location.end.line - arg1.location.start.line;
    lineWidth += arg2.location.end.line - arg2.location.start.line;

    this.mutationResults = {
      columnWidth,
      lineWidth,
      locations: {
        [location.filePath]: [
          arg1.location,
          arg2.location,
        ]  
      }
    };
  }

  async *onEvaluation() { }

  async process(data, cache: AstCache) {
    const ast = await cache.get(this.location.filePath);

    const nodePaths = findNodePathsWithLocation(ast, this.location)
      .filter(path => path.isCallExpression());
    assertFoundNodePaths(nodePaths, this.location);

    const nodePath = nodePaths[0] as NodePath<t.CallExpression>;
    const args = nodePath.node.arguments;

    const temp = args[this.arg1.index];
    args[this.arg1.index] = args[this.arg2.index];
    args[this.arg2.index] = temp;
  }
}

const SWAP_FUNCTION_PARAMS = Symbol('swap-function-params');
type SwapFunctionInformation = {
  location: ExpressionLocation,
  index: number,
};

class SwapFunctionParametersInstruction implements Instruction {
  public readonly type: Symbol = SWAP_FUNCTION_PARAMS;
  public readonly mutationCount: number = 2;
  public readonly mutationsLeft: number = 1;
  public readonly mutationResults: MutationResults;
  public readonly atomicMutation: boolean = true;

  constructor(
    private readonly location: Location,
    private readonly param1: SwapFunctionInformation,
    private readonly param2: SwapFunctionInformation,
    public readonly totalNodes: number,
  ) {
    let columnWidth = 0;
    let lineWidth = 0;

    lineWidth += param1.location.end.line - param1.location.start.line;
    lineWidth += param2.location.end.line - param2.location.start.line;

    columnWidth += param1.location.end.column - param1.location.start.column;
    columnWidth += param2.location.end.column - param2.location.start.column;

    this.mutationResults = {
      columnWidth,
      lineWidth,
      locations: {
        [location.filePath]: [
          param1.location,
          param2.location,
        ]  
      }
    };
  }

  isRemovable() {
    return true;
  }

  async *onEvaluation() {}

  async process(data, cache: AstCache) {
    const ast = await cache.get(this.location.filePath);
    
    const nodePaths = findNodePathsWithLocation(ast, this.location)
      .filter(path => path.isFunction());
    assertFoundNodePaths(nodePaths, this.location);

    const nodePath = nodePaths[0] as NodePath<t.Function>;
 
    if (nodePath) {
      const params = nodePath.node.params;
      const temp = params[this.param1.index];
      params[this.param1.index] = params[this.param2.index];
      params[this.param2.index] = temp;
    }
  }
}

class SwapFunctionParametersFactory implements InstructionFactory<SwapFunctionParametersInstruction> {
  *createInstructions() { }

  *createPreBlockInstructions(nodePath: NodePath, filePath, derivedFromPassingTests) {
    if(nodePath.isFunction() && nodePath.node.loc) {
      const node = nodePath.node;
      const params = node.params;
      for(let p = 1; p < node.params.length; p++) {
        const param1 = params[p - 1];
        const param2 = params[p];
        if (param1.loc && param2.loc) {
          yield createInstructionHolder(
            new SwapFunctionParametersInstruction(
              { ...nodePath.node.loc, filePath }, 
              {
                index: p - 1,
                location: param1.loc
              }, {
                index: p,
                location: param2.loc
              },
              param1[TOTAL_NODES] + param2[TOTAL_NODES]
            ), 
            derivedFromPassingTests
          );
        }
      }
    }
  }

  onInitialPass() { }
}

class SwapFunctionCallArgumentsFactory implements InstructionFactory<SwapFunctionCallArgumentsInstruction> {
  *createInstructions() { }

  *createPreBlockInstructions(nodePath: NodePath, filePath: string, derivedFromPassingTests) {
    if(nodePath.isCallExpression() && nodePath.node.loc) {
      const node = nodePath.node;
      const params = node.arguments;
      for(let p = 1; p < node.arguments.length; p++) {
        const param1 = params[p - 1];
        const param2 = params[p];
        if (param1.loc && param2.loc) {
          yield createInstructionHolder(
            new SwapFunctionCallArgumentsInstruction(
              { ...nodePath.node.loc, filePath }, 
              {
                index: p - 1,
                location: param1.loc
              }, {
                index: p,
                location: param2.loc
              },
              param1[TOTAL_NODES] + param2[TOTAL_NODES]
            ), 
            derivedFromPassingTests
          );
        }
      }
    }
  }

  onInitialPass() { }
}

class InvertBooleanLiteralInstructionFactory implements InstructionFactory<InvertBooleanLiteralInstruction> {
	*createInstructions(nodePath, filePath, derivedFromPassingTests) {
		if (nodePath.isBooleanLiteral()) {
      yield createInstructionHolder(new InvertBooleanLiteralInstruction({...nodePath.node.loc, filePath}, nodePath.node[TOTAL_NODES]), derivedFromPassingTests);
    }
  }

  *createPreBlockInstructions() {

  }

  onInitialPass() {

  }
}

class AssignmentFactory implements InstructionFactory<AssignmentInstruction>{
  constructor(private readonly operations: CategoryData<string>) {}

  onInitialPass() { }

  *createPreBlockInstructions() {
    
  }

  *createInstructions(path, filePath, derivedFromPassingTest) {
    const node = path.node;
    if(path.isAssignmentExpression() && node.loc) {
      const operators = matchAndFlattenCategoryData(node.operator, this.operations);
      if (operators.length > 0) {
        yield createInstructionHolder(new AssignmentInstruction({ filePath, ...node.loc }, operators, node[TOTAL_NODES]), derivedFromPassingTest);
      }
    }
  }
}

class BinaryFactory implements InstructionFactory<BinaryInstruction>{
  constructor(private readonly operations: CategoryData<string>) {}
  
  onInitialPass() { }

  *createPreBlockInstructions() {

  }

  *createInstructions(path, filePath, derivedFromPassingTest) {
    const node = path.node;
    if((path.isBinaryExpression() || path.isLogicalExpression()) && node.loc) {
      const operators = matchAndFlattenCategoryData(node.operator, this.operations);
      if (operators.length > 0) {
        yield createInstructionHolder(new BinaryInstruction({ filePath, ...node.loc }, operators, node[TOTAL_NODES]), derivedFromPassingTest);
      }
    }
  }
}

export const assignmentCategories = [
  ['^=', ['&=', '>>='], ['|=', '<<=']], [['/=', '*='],['-=', '+=']]
];
const instructionFactories: InstructionFactory<any>[] = [
  new AssignmentFactory(assignmentCategories),
  new BinaryFactory(binaryOperationCategories),
  new ReplaceStringFactory(),
  new InvertBooleanLiteralInstructionFactory(),
  new SwapFunctionParametersFactory(),
  new SwapFunctionCallArgumentsFactory(),
  new ReplaceNumberFactory(),
];
const RETRIES = 1;

const statementDepth = (statements: StatementInformation[]) => {
  if (statements.length <= 0) {
    return 0;
  }
  let largestInnerDepth = 0;
  for(const statement of statements) {
    const depth = statementDepth(statement.innerStatements);
    if (depth > largestInnerDepth) {
      largestInnerDepth = depth;
    }
  }
  return largestInnerDepth + 1;
}

const findAllNodePaths= async (cache: AstCache, locations: Location[]) => {
  const nodePaths: any = [];
  for(const location of locations) {
    const ast = await cache.get(location.filePath);
  
    nodePaths.push(...findNodePathsWithLocation(ast, location).map(nodePath => ({ ...nodePath, filePath: location.filePath })));  
  }
  return nodePaths.sort((path1, path2) => {
    const filePathComparison = path1.filePath.localeCompare(path2.filePath)
    if (filePathComparison !== 0) {
      return filePathComparison;
    }
    const startLineComparison = path1.node.loc.start.line - path2.node.loc.start.line;
    if (startLineComparison !== 0) {
      return startLineComparison;
    }
    const startColumnComparison = path1.node.loc.start.column - path2.node.loc.start.column;
    if (startColumnComparison !== 0) {
      startColumnComparison
    }
    
    const endLineComparison = path2.node.loc.end.line - path1.node.loc.end.line;
    if (endLineComparison !== 0) {
      return endLineComparison;
    }
    const endColumnComparison = path2.node.loc.end.column - path1.node.loc.end.column;
    if (endColumnComparison !== 0) {
      return endColumnComparison;
    }
    return 0;
  });
}

const isStatementContainer = (path: NodePath<any>) => {
  const node = path.node;
  return (node.body && (Array.isArray(node.body) || !node.body.body)) || (path.isIfStatement() && ((node.alternate && !node.alternate.body) || !node.consequent.body));
}

const stubLocationEvaluation = (location: Location, totalNodes: number): LocationEvaluation => {
  return {
    totalAtomicMutationsPerformed: 0,
    totalNodes,
    location,
    evaluations: [],
  }
}

const TOTAL_NODES = Symbol('total-nodes');
function identifyUnknownInstruction(
  nodePaths: any[],
  derivedFromPassingTest: boolean, 
): StatementInformation[][] {
  const initialExpressionsSeen: Set<string> = new Set();
  for(const nodePath of nodePaths) {
    const scopedPath = getParentScope(nodePath);
    const nodeCounts: number[] = [];
    const enter = (path) => {
      const key = expressionKey(nodePath.filePath, path.node);
      if (initialExpressionsSeen.has(key)) {
        return;
      }
      nodeCounts.push(1);
      for(const instructionFactory of instructionFactories) {
        instructionFactory.onInitialPass(path, nodePath.filePath, derivedFromPassingTest);
      }
    };
    const exit = (path) => {
      const key = expressionKey(nodePath.filePath, path.node);
      if (initialExpressionsSeen.has(key)) {
        if (nodeCounts.length > 0 && path.parentPath && !path.parentPath.node[TOTAL_NODES]) {
          nodeCounts[nodeCounts.length - 1] += path.node[TOTAL_NODES];
        }
        return;
      }
      initialExpressionsSeen.add(key);
      const totalNodes = nodeCounts.pop()!;
      if (nodeCounts.length > 0) {
        nodeCounts[nodeCounts.length - 1] += totalNodes;
      }
      path.node[TOTAL_NODES] = totalNodes;
    }
    enter(scopedPath);
    scopedPath.traverse({
      enter,
      exit
    });
    exit(scopedPath);
  }
  const expressionsSeen: Set<string> = new Set();
  //console.log(nodePaths);
  const statements: StatementInformation[] = [];
  for(const nodePath of nodePaths) {
    console.log('SCANNING', expressionKey(nodePath.filePath, nodePath.node));
    const scopedPath = getParentScope(nodePath);
    const currentStatementStack: StatementInformation[][] = [];
    console.log('SCOPEd', expressionKey(nodePath.filePath, scopedPath.node));
    const enter = (path: NodePath) => {
      const node = path.node;
      const parentPath = path.parentPath;
      const key = expressionKey(nodePath.filePath, node);
      if (expressionsSeen.has(key)) {
        return;
      }
      if (parentPath && 
        (
          (parentPath.node.body && ((path.key === 'body' && !node.body) || (Array.isArray(parentPath.node.body) && typeof path.key === 'number'))) ||
          (parentPath.isIfStatement() && parentPath.node.consequent && (!parentPath.node.consequent.body || (parentPath.node.alternate && !parentPath.node.alternate.body)) && ['consequent', 'alternate'].includes(path.key))
        ) && 
        node.loc && currentStatementStack.length > 0) {
        console.log('statement', expressionKey(nodePath.filePath, node), currentStatementStack.length, node[TOTAL_NODES])
        currentStatementStack[currentStatementStack.length - 1].push({
          index: path.key,
          filePath: nodePath.filePath,
          instructionHolders: [],
          innerStatements: [],
          location: node.loc,
          retries: RETRIES,
          totalNodes: node[TOTAL_NODES]
        });
      }
      if(currentStatementStack.length > 0) {
        const statementStack = currentStatementStack[currentStatementStack.length - 1];
        if (statementStack.length > 0) {
          const statement = statementStack[statementStack.length - 1];
          for(const factory of instructionFactories) {
            statement.instructionHolders.push(...factory.createPreBlockInstructions(path, nodePath.filePath, derivedFromPassingTest));
          }
        }
      }

      if (isStatementContainer(path)) {
        console.log('block', node.type, currentStatementStack.length);
        currentStatementStack.push([]);
      }
      if(currentStatementStack.length > 0) {
        const statementStack = currentStatementStack[currentStatementStack.length - 1];
        if (statementStack.length > 0) {
          const statement = statementStack[statementStack.length - 1];
          for(const factory of instructionFactories) {
            statement.instructionHolders.push(...factory.createInstructions(path, nodePath.filePath, derivedFromPassingTest));
          }  
        }
      }
    };
    const exit = (path: NodePath) => {
      const node = path.node;
      const key = expressionKey(nodePath.filePath, node);
      if (expressionsSeen.has(key)) {
        return
      }
      expressionsSeen.add(key);
      if (isStatementContainer(path)) {
        const poppedStatementInfo = currentStatementStack.pop()!;
        if (currentStatementStack.length <= 0) {
          statements.push(...poppedStatementInfo);
        } else {
          const newTopStackStatementInfo = currentStatementStack[currentStatementStack.length - 1];
          const lastStatement = newTopStackStatementInfo[newTopStackStatementInfo.length - 1];
          lastStatement.innerStatements.push(...poppedStatementInfo);
        }
      }
    };
    enter(scopedPath);
    scopedPath.traverse({
      enter,
      exit
    });
    exit(scopedPath);
  }
  const maxDepth = statementDepth(statements);
  const comparator = (a, b) => b.length - a.length;
  const statementBlocks: StatementInformation[][] = [];
  for(let d = 0; d < maxDepth; d++) {
    statementBlocks.push([]);
  }
  for(const statement of statements) {
    let stack = [statement];
    const statementLayers: StatementInformation[][] = [];
    do {
      const nextStack: StatementInformation[] = [];
      for(const item of stack) {
        nextStack.push(...item.innerStatements);
      }
      statementLayers.push(stack);
      stack = nextStack;
    } while(stack.length > 0)
    statementLayers.sort(comparator);
    for(let b = 0; b < statementLayers.length; b++) {
      statementBlocks[b].push(...statementLayers[b]);
    }
    statementBlocks.sort(comparator);
  }
  const originalLength = statementBlocks.length;
  for(let i = 0; i < originalLength; i++) {
    const statementBlock = statementBlocks[i];
    if (statementBlock.length > 1) {
      const mid = Math.trunc(statementBlock.length / 2);
      statementBlocks.push(statementBlock.splice(mid));
    }
  }

  return statementBlocks;
};

export type TestEvaluation = {
  // Whether the exception that was thrown in the test has changed
  errorChanged: boolean | null;
  // How much better we're doing in terms of whether the test failed/passed
  endResultChange: number;
  previouslyFailing: boolean,
} & StackEvaluation;

type StackEvaluation = {
  stackColumnScore: number | null;
  stackLineScore: number | null;
};

const nothingChangedMutationStackEvaluation = (e: MutationStackEvaluation) => {
  return e.columnDegradationScore === 0 && e.columnImprovementScore === 0 && e.lineDegradationScore === 0 && e.lineImprovementScore === 0;
};

export const compareMutationEvaluationsWithLesserProperties = (r1: MutationEvaluation, r2: MutationEvaluation) => {
  const comparison = compareMutationEvaluations(r1, r2);
  if (comparison !== 0) {
    return comparison;
  }
  if (!r1.crashed && !r2.crashed) {
    const result1 = r1 as NormalMutationEvaluation;
    const result2 = r2 as NormalMutationEvaluation;
    
    const stackEval1 = result1.stackEvaluation;
    const stackEval2 = result2.stackEvaluation;
  
    // TODO: stack null scores tell us very little but maybe more is better? Verify
    const lineScoreNulls = stackEval1.lineScoreNulls - stackEval2.lineScoreNulls;
    if (lineScoreNulls !== 0) {
      return lineScoreNulls;
    }
  
    const columnScoreNulls = stackEval1.columnScoreNulls - stackEval2.columnScoreNulls;
    if (columnScoreNulls !== 0) {
      return columnScoreNulls;
    }  
  }
  return 0;
}

/**
 * From worst evaluation to best evaluation
 */
export const compareMutationEvaluations = (
  r1: MutationEvaluation,
  r2: MutationEvaluation,
) => {
  if (r1.partial && !r2.partial) {
    return -1;
  } else if (!r1.partial && r2.partial) {
    return 1;
  }
  if (r1.crashed && r2.crashed) {
    return 0;
  } else if (r1.crashed && !r2.crashed) {
    return -1
  } else if (!r1.crashed && r2.crashed) {
    return 1;
  }
  const goodThingsHappened1 = evaluationDidSomethingGoodOrCrashed(r1) ? 1 : -1;
  const goodThingsHappened2 = evaluationDidSomethingGoodOrCrashed(r2) ? 1 : -1;
  const goodThingsHappenedComparison = goodThingsHappened1 - goodThingsHappened2;
  if (goodThingsHappenedComparison !== 0) {
    return goodThingsHappenedComparison;
  }

  const nothingBadHappened1 = evaluationDidNothingBad(r1) ? 1 : -1;
  const nothingBadHappened2 = evaluationDidNothingBad(r2) ? 1 : -1;
  const nothingBadHappenedComparison = nothingBadHappened1 - nothingBadHappened2;
  if (nothingBadHappenedComparison !== 0) {
    return nothingBadHappenedComparison;
  }

  // TODO: TypeScript should have inferred that this would be the case..
  const result1 = r1 as NormalMutationEvaluation;
  const result2 = r2 as NormalMutationEvaluation;

  const stackEval1 = result1.stackEvaluation;
  const stackEval2 = result2.stackEvaluation;


  const netTestImprovement1 = result1.testsImproved - result1.testsWorsened;
  const netTestImprovement2 = result2.testsImproved - result2.testsWorsened;

  const netTestImprovementComparison = netTestImprovement1 - netTestImprovement2;
  if (netTestImprovementComparison !== 0) {
    return netTestImprovementComparison;
  }


  const testsImproved = result1.testsImproved - result2.testsImproved;
  if (testsImproved !== 0) {
    return testsImproved;
  }


  const netLineImprovement1 = stackEval1.lineImprovementScore - stackEval1.lineDegradationScore;
  const netLineImprovement2 = stackEval2.lineImprovementScore - stackEval2.lineDegradationScore;

  const netLineImprovementComparison = netLineImprovement1 - netLineImprovement2;
  if (netLineImprovementComparison !== 0) {
    return netLineImprovementComparison;
  }
  
  const lineImprovementScore = stackEval1.lineImprovementScore - stackEval2.lineImprovementScore;
  if (lineImprovementScore !== 0) {
    return lineImprovementScore;
  }

  
  const netColumnImprovement1 = stackEval1.columnImprovementScore - stackEval1.columnDegradationScore;
  const netColumnImprovement2 = stackEval2.columnImprovementScore - stackEval2.columnDegradationScore;

  const netColumnImprovementComparison = netColumnImprovement1 - netColumnImprovement2;
  if (netColumnImprovementComparison !== 0) {
    return netColumnImprovementComparison;
  }

  const columnImprovementScore =
    stackEval1.columnImprovementScore - stackEval2.columnImprovementScore;
  if (columnImprovementScore !== 0) {
    return columnImprovementScore;
  }

  const errorsChanged = result1.errorsChanged - result2.errorsChanged;
  if (errorsChanged !== 0) {
    return errorsChanged;
  }

  const atomicMutation = (result1.atomicMutation ? -1 : 1) - (result2.atomicMutation ? -1 : 1);
  if (atomicMutation !== 0) {
    console.log('z', result1.atomicMutation, result2.atomicMutation);
    return atomicMutation
  }

  /*
  const totalNodes = result1.totalNodes - result2.totalNodes;
  if (totalNodes !== 0) {
    return totalNodes;
  }*/

  return 0;
};

export const evaluateStackDifference = (
  originalResult: TestResult,
  newResult: TestResult,
): StackEvaluation => {
  // TODO: Just make passing test cases have null as the stack property
  if ((newResult as any).stack == null || (originalResult as any).stack == null) {
    return {
      stackColumnScore: null,
      stackLineScore: null,
    };
  }
  const newStackInfo = ErrorStackParser.parse({ stack: (newResult as any).stack } as Error);
  const oldStackInfo = ErrorStackParser.parse({ stack: (originalResult as any).stack } as Error);

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
  const endResultChange: number = samePassFailResult
    ? EndResult.UNCHANGED
    : newResult.passed
    ? EndResult.BETTER
    : EndResult.WORSE;
  const errorChanged: boolean | null = (() => {
    if (!samePassFailResult) {
      return null;
    }
    if (newResult.passed) {
      return false;
    }
    return (newResult as any).stack !== (originalResult as FailingTestData).stack;
  })();
  const stackEvaluation = evaluateStackDifference(originalResult, newResult);

  const evaluation = {
    ...stackEvaluation,
    endResultChange,
    errorChanged,
    previouslyFailing: !originalResult.passed,
  };
  return evaluation;
};

type MutationStackEvaluation = {
  lineDegradationScore: number;
  columnDegradationScore: number;
  lineScoreNulls: number;
  columnScoreNulls: number;
  lineImprovementScore: number;
  columnImprovementScore: number;
}
const createMutationStackEvaluation = (): MutationStackEvaluation => ({
  lineDegradationScore: 0,
  columnDegradationScore: 0,
  lineScoreNulls: 0,
  columnScoreNulls: 0,
  lineImprovementScore: 0,
  columnImprovementScore: 0
});

export type CommonMutationEvaluation = {
  type: Symbol,
  totalNodes: number,
  atomicMutation: boolean,
  partial: boolean,
};
export type CrashedMutationEvaluation = {
  stackEvaluation: null,
  testsWorsened: null;
  testsImproved: null;
  errorsChanged: null;
  crashed: true;
} & CommonMutationEvaluation;
export type NormalMutationEvaluation = {
  stackEvaluation: MutationStackEvaluation,
  testsWorsened: number;
  testsImproved: number;
  errorsChanged: number;
  crashed: false;
} & CommonMutationEvaluation;

export type MutationEvaluation = CrashedMutationEvaluation | NormalMutationEvaluation;

const evaluateNewMutation = (
  originalResults: TesterResults,
  newResults: TesterResults,
  instruction: InstructionHolder,
  partial: boolean,
): MutationEvaluation => {
  const notSeen = new Set(originalResults.testResults.keys());
  let testsWorsened = 0;
  let testsImproved = 0;
  let stackEvaluation: MutationStackEvaluation = createMutationStackEvaluation();
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
    if (testEvaluation.endResultChange === EndResult.BETTER) {
      testsImproved++;
    } else if (testEvaluation.endResultChange === EndResult.WORSE) {
      testsWorsened++;
    } else if (testEvaluation.errorChanged && (testEvaluation.stackLineScore === 0 || testEvaluation.stackColumnScore === null) && (testEvaluation.stackColumnScore === 0 || testEvaluation.stackColumnScore === null)) {
      errorsChanged++;
    }

    if (testEvaluation.stackLineScore === null) {
      stackEvaluation.lineScoreNulls++;
    } else if (testEvaluation.stackLineScore > 0) {
      stackEvaluation.lineImprovementScore += testEvaluation.stackLineScore;
    } else if (testEvaluation.stackLineScore < 0) {
      stackEvaluation.lineDegradationScore -= testEvaluation.stackLineScore;
    } else if (testEvaluation.stackColumnScore === null) {
      stackEvaluation.columnScoreNulls++;
    } else if (testEvaluation.stackColumnScore > 0) {
      stackEvaluation.columnImprovementScore += testEvaluation.stackColumnScore;
    } else if (testEvaluation.stackColumnScore < 0) {
      stackEvaluation.columnDegradationScore -= testEvaluation.stackColumnScore;
    }
  }
  return {
    type: instruction.instruction.type,
    atomicMutation: instruction.instruction.atomicMutation,
    totalNodes: instruction.instruction.totalNodes,
    testsWorsened,
    testsImproved,
    stackEvaluation,
    errorsChanged,
    crashed: false,
    partial,
  };
};

const locationToKey = (filePath: string, location?: ExpressionLocation | null) => {
  if (!location) {
    return filePath;
  }
  return `${filePath}:${location.start.line}:${location.start.column}`;
};
const locationToKeyIncludingEnd = (filePath: string, location?: ExpressionLocation | null) => {
  if (!location) {
    return filePath;
  }
  const withStart = locationToKey(filePath, location);
  if (location.end === null) {
     return withStart;
  }
   return `${withStart}:${location.end.line}:${location.end.column}`;
};

const compareMutationEvaluationsWithLargeMutationCountsFirst = (a: MutationEvaluation, b: MutationEvaluation) => {
  if (a.partial === b.partial) {
    const atomicMutation = (a.atomicMutation ? 1 : -1) - (b.atomicMutation ? 1 : -1)
    if (atomicMutation !== 0) {
      return atomicMutation;
    }
  }
  return compareMutationEvaluationsWithLesserProperties(a, b);
}

export const compareLocationEvaluations = (aL: LocationEvaluation, bL: LocationEvaluation) => {
  const a = aL.evaluations;
  const b = bL.evaluations;
  const aSingleMutationsOnly = a.sort(compareMutationEvaluationsWithLargeMutationCountsFirst).reverse();
  const bSingleMutationsOnly = b.sort(compareMutationEvaluationsWithLargeMutationCountsFirst).reverse();
  let aI = 0;
  let bI = 0;
  // Assumption: All arrays are at least .length > 0
  do {
    const comparison = compareMutationEvaluations(aSingleMutationsOnly[aI], bSingleMutationsOnly[bI]);
    if (comparison !== 0) {
      console.log('a', comparison, aI, bI);
      return comparison;
    }

    const roomForMutationComparison = (aL.totalNodes - aL.totalAtomicMutationsPerformed) - (bL.totalNodes - bL.totalAtomicMutationsPerformed);
    if (roomForMutationComparison !== 0) {
      console.log('b', roomForMutationComparison)
      return roomForMutationComparison;
    }

    const comparison2 = compareMutationEvaluationsWithLesserProperties(aSingleMutationsOnly[aI], bSingleMutationsOnly[bI]);
    if (comparison2 !== 0) {
      console.log('c', comparison2)
      return comparison2;
    }

    aI++;
    bI++;
  } while(aI < aSingleMutationsOnly.length && bI < bSingleMutationsOnly.length)
  return bSingleMutationsOnly.length - aSingleMutationsOnly.length;
}

type LocationEvaluation = {
  evaluations: MutationEvaluation[],
  location: Location,
  totalNodes: number,
  totalAtomicMutationsPerformed: number
}
export const mutationEvalatuationMapToFaults = (
  locationEvaluations: Map<string, LocationEvaluation>,
): Fault[] => {
  const locationEvaluationsList: LocationEvaluation[] = [...locationEvaluations.values()];
  locationEvaluationsList.sort(compareLocationEvaluations);
  const faults = locationEvaluationsList.map((lE, i): Fault => {
    console.log(lE.evaluations.map(e => e.atomicMutation))
    return {
      score: i,
      sourcePath: lE.location.filePath,
      location: {
        start: lE.location.start,
        end: lE.location.end,
      },
      other: {
        totalAtomicMutationsPerformed: lE.totalAtomicMutationsPerformed,
        totalNodes: lE.totalNodes,
        evaluation: lE.evaluations
      }
    };
  });
  return faults;
};

type IsFinishedFunction = (instruction: InstructionHolder<any>, finishData: MiscFinishData) => boolean;
export type PluginOptions = {
  faultFilePath?: string,
  babelOptions?: ParserOptions,
  ignoreGlob?: string[] | string,
  onMutation?: (mutatatedFiles: string[]) => any,
  isFinishedFn?: IsFinishedFunction,
  mapToIstanbul?: boolean,
  allowPartialTestRuns?: boolean
};

type DefaultIsFinishedOptions = {
  mutationThreshold?: number,
  durationThreshold?: number,
  finishOnPassDerviedNonFunctionInstructions?: boolean,
}

type MiscFinishData = {
  mutationCount: number,
  testerResults: TesterResults,
}


export const createDefaultIsFinishedFn = ({
  mutationThreshold,
  durationThreshold,
  finishOnPassDerviedNonFunctionInstructions = true
}: DefaultIsFinishedOptions = {}): IsFinishedFunction => {
  const isFinishedFn: IsFinishedFunction = ({ data, instruction }: InstructionHolder<any>, finishData: MiscFinishData): boolean => {
    if (durationThreshold !== undefined && finishData.testerResults.duration >= durationThreshold) {
      console.log('a');
      return true;
    }

    if(mutationThreshold !== undefined && finishData.mutationCount >= mutationThreshold) {
      console.log('b');
      return true;
    }

    // TODO: Should just never add them to the queue in the first place
    if (finishOnPassDerviedNonFunctionInstructions && data.derivedFromPassingTest) {
      console.log('c');
      return true;
    }

    if (data.mutationEvaluations.length > 0) {
      // TODO: Might need to rethink using mutationCount if multi mutation instructions exist outside the delete statement phase
      const hasAtomicMutations = data.mutationEvaluations.some(e => e.atomicMutation);
      const mostSpecificMutations = data.mutationEvaluations.filter(e =>e.atomicMutation === hasAtomicMutations);
      const mostSpecificMutationsOnlyContainCrashes = mostSpecificMutations.filter(evaluation => evaluation.crashed).length === mostSpecificMutations.length;
      if (!mostSpecificMutationsOnlyContainCrashes) {
        const containsUsefulMutations = data.mutationEvaluations.some(evaluation => {
          const improved = 
            !evaluation.crashed && (
            evaluation.testsImproved > 0 
            || evaluation.errorsChanged > 0 
            || evaluation.stackEvaluation.lineImprovementScore > 0
            || evaluation.stackEvaluation.columnImprovementScore > 0);
          const nothingChangedInNonDeleteStatement = !evaluation.crashed && (evaluation.errorsChanged === 0 
            && evaluation.testsImproved === 0
            && evaluation.testsWorsened === 0
            && nothingChangedMutationStackEvaluation(evaluation.stackEvaluation)
            && evaluation.type !== DELETE_STATEMENT
          );
          return improved || nothingChangedInNonDeleteStatement;
        })
        if (!containsUsefulMutations) {
          console.log('d');
          return true;
        }
      }
    }

    return false;
  };
  return isFinishedFn;
}

export const isLocationWithinBounds = (loc: ExpressionLocation, statement: ExpressionLocation) => {
  const lineWithin = loc.start.line > statement.start.line && loc.start.line < statement.end.line;
  const onStartLineBound = loc.start.line === statement.start.line && loc.start.column >= statement.start.column && (loc.start.line !== statement.end.line || loc.start.column <= statement.end.column);
  const onEndLineBound = loc.start.line === statement.end.line && loc.start.column <= loc.end.column && (loc.start.line !== statement.start.line || loc.start.column >= statement.start.column);
  return lineWithin || onStartLineBound || onEndLineBound;
}

export const mapLocationEvaluationsToIstanbulCoverage = (originalMap: Map<string, LocationEvaluation>, coverage: Coverage): Map<string, LocationEvaluation> => {
  // TODO: Could make this more efficient
  const mappedLocations: Map<string, LocationEvaluation> = new Map();
  const replace = (originalEvaluation: LocationEvaluation, location: ExpressionLocation) => {
    const key = locationToKeyIncludingEnd(originalEvaluation.location.filePath, location);
    if (!mappedLocations.has(key)) {
      // TODO: Super gross that i'm assuming the original map had the location
      const original = originalMap.get(key)!;
      mappedLocations.set(key, {
        evaluations: [],
        totalAtomicMutationsPerformed: 0,
        totalNodes: 0,
        location: original.location,
      });
    }
    const locationEvaluation = mappedLocations.get(key)!;
    locationEvaluation.evaluations.push(...originalEvaluation.evaluations)
    locationEvaluation.totalAtomicMutationsPerformed += originalEvaluation.totalAtomicMutationsPerformed;
    if(originalEvaluation.totalNodes > locationEvaluation.totalNodes) {
      locationEvaluation.totalNodes = originalEvaluation.totalNodes;
    }
  };

  for (const locationEvaluation of originalMap.values()) {
    const loc = locationEvaluation.location;
    const fileCoverage = coverage[loc.filePath];
    if (fileCoverage === undefined) {
      continue;
    }
    
    let mostRelevantStatement: ExpressionLocation | null = null;
    const locLineWidth = Math.abs(loc.end.line - loc.start.line) + 1; // + 1 cause the line it's on counts as one
    const locColumnWidth = Math.abs(loc.end.column - loc.start.column);
    for(const statement of Object.values(fileCoverage.statementMap)) {
      if (isLocationWithinBounds(loc, statement) || isLocationWithinBounds(statement, loc)) {
        if (mostRelevantStatement === null) {
          mostRelevantStatement = statement;
        } else {
          const lineDistance = Math.abs(statement.start.line - loc.start.line);
          const columnDistance = Math.abs(statement.start.column - loc.start.column);

          const oLineDistance = Math.abs(mostRelevantStatement.start.line - loc.start.line);
          const oColumnDistance = Math.abs(mostRelevantStatement.start.column - loc.start.column);

          if (lineDistance < oLineDistance || (lineDistance === oLineDistance && columnDistance < oColumnDistance)) {
            mostRelevantStatement = statement;
          } else {
            const lineWidth = Math.abs(statement.end.line - statement.start.line);
            const columnWidth = Math.abs(statement.end.column - statement.start.column);

            const oLineWidth = Math.abs(mostRelevantStatement.end.line - mostRelevantStatement.start.line);
            const oColumnWidth = Math.abs(mostRelevantStatement.end.column - mostRelevantStatement.start.column);              


            const lineDisimilarity = Math.abs(locLineWidth - lineWidth);
            const columnDisimilarity = Math.abs(locColumnWidth - columnWidth);

            const oLineDisimilarity = Math.abs(locLineWidth - oLineWidth);
            const oColumnDisimilarity = Math.abs(locColumnWidth - oColumnWidth);

            if (lineDisimilarity < oLineDisimilarity || (lineDisimilarity === oLineDisimilarity && columnDisimilarity < oColumnDisimilarity)) {
              mostRelevantStatement = statement;
            }
          }
        }  
      }
    }

    if (mostRelevantStatement !== null) {
      replace(locationEvaluation, mostRelevantStatement);
    }
  }
  return mappedLocations;
}

const resetMutationsInInstruction = async (instruction: InstructionHolder) => {
  const previousMutationResults = instruction.instruction.mutationResults;

  // Revert all mutated files
  await Promise.all(Object.keys(previousMutationResults.locations).map(
    filePath => resetFile(filePath)
  ));
}

type LocationKey = string;
const heapComparisonFn = (a, b) => -compareInstructions(a, b);
export const createPlugin = ({
  faultFilePath = './faults/faults.json',
  babelOptions,
  ignoreGlob = [],
  onMutation = () => {},
  isFinishedFn = createDefaultIsFinishedFn(),
  mapToIstanbul = false,
  allowPartialTestRuns = false
}: PluginOptions): PartialTestHookOptions => {
  let previousInstruction: InstructionHolder = null!;
  let finished = false;
  const instructionQueue: Heap<InstructionHolder> = new Heap(heapComparisonFn);
  let firstRun = true;  
  let firstTesterResults: TesterResults;
  const failingTestFiles: Set<string> = new Set();
  let previousRunWasPartial = false;

  const locationEvaluations: Map<LocationKey, LocationEvaluation> = new Map();
  let mutationCount = 0;
  const resolvedIgnoreGlob = (Array.isArray(ignoreGlob) ? ignoreGlob : [ignoreGlob]).map(glob =>
    resolve('.', glob).replace(/\\+/g, '/'),
  );
  const analyzeEvaluation = async (mutationEvaluation: MutationEvaluation, cache: AstCache) => {    
    if (previousInstruction !== null) {
      console.log(mutationEvaluation);
      const previousMutationResults = previousInstruction.instruction.mutationResults;

      // Revert all mutated files
      await Promise.all(Object.keys(previousMutationResults.locations).map(resetFile));

      //console.log(locationToKey(previousInstruction.data.location.filePath, previousInstruction.data.location), { ...mutationEvaluation, mutations: undefined });

      if (!(previousInstruction.instruction instanceof DeleteStatementInstruction)) {
        previousInstruction.data.mutationEvaluations.push(mutationEvaluation);
      }

      for(const [filePath, expressionLocations] of Object.entries(previousMutationResults.locations)) {
        for(const expressionLocation of expressionLocations) {
          const key = locationToKeyIncludingEnd(filePath, expressionLocation);
          const locationEvaluation = locationEvaluations.get(key)!;
          locationEvaluation.evaluations.push(mutationEvaluation);
          if (mutationEvaluation.atomicMutation) {
            locationEvaluation.totalAtomicMutationsPerformed++;
          }
        }
      }

      for await(const newInstruction of previousInstruction.instruction.onEvaluation(mutationEvaluation, previousInstruction.data, cache)) {
        if (!newInstruction) {
          throw new Error(`Instruction was ${newInstruction}`);
        }
        instructionQueue.push(newInstruction);
      }

      if (previousInstruction.instruction.isRemovable(mutationEvaluation, previousInstruction.data)) {
        // Can't assume it's at the top of the heap and therefore can't use pop because any new instruction (onEvaluation) could technically end up at the top too
        instructionQueue.delete(previousInstruction);
      } else {
        instructionQueue.update(previousInstruction);
      }
    }
  }

  const runInstruction = async (tester: TesterResults, cache: AstCache) => {
    console.log('Processing instruction')
    let count = 0;
    for(const instruction of instructionQueue.unsortedIterator()) {
      count += instruction.instruction.mutationsLeft;
    }
    console.log(`${count} instructions`);

    if (instructionQueue.length <= 0) {
      finished = true;
      return false;
    }

    console.log('set peaking')
    const instruction = instructionQueue.peek()!;
    console.log(instruction.instruction.type);
    previousInstruction = instruction;

    //console.log('processing')
    
    await instruction.instruction.process(instruction.data, cache);

    if (isFinishedFn(instruction, { mutationCount, testerResults: tester })) {
      console.log('finished');
      // Avoids evaluation the same instruction twice if another addon requires a rerun of tests
      finished = true;
      return false;
    }

    const mutationResults = instruction.instruction.mutationResults;

    mutationCount++;
    
    const mutatedFilePaths = Object.keys(mutationResults.locations);
    console.log(mutatedFilePaths);
    await Promise.all(
      mutatedFilePaths.map(filePath =>
        createTempCopyOfFileIfItDoesntExist(filePath),
      ),
    );

    await Promise.all(
      mutatedFilePaths
        .map(async filePath => {
          const originalCodeText = await readFile(filePath, 'utf8');
          const ast = await cache.get(filePath);
          const { code } = generate(
            ast, 
            { retainFunctionParens: true, retainLines: true, compact: false, filename: basename(filePath) }, 
            originalCodeText
          );
          await writeFile(filePath, code, { encoding: 'utf8' });
        })
    );

    await Promise.resolve(onMutation(mutatedFilePaths));
    mutationsAttempted++;
    return true;
  }

  let mutationsAttempted = 0;
  return {
    on: {
      start: async () => {
        // TODO: Types appear to be broken with mkdtemp
        copyTempDir = await (mkdtemp as any)(join(tmpdir(), 'fault-addon-mutation-localization-'));
      },
      allFilesFinished: async (tester: TesterResults) => {
        if(finished) {
          return null;
        }
        //console.log('finished all files')
        const cache = createAstCache(babelOptions);
        if (firstRun) {
          firstTesterResults = tester;
          firstRun = false;
          const failedCoverageMap = createCoverageMap({});
          for (const testResult of tester.testResults.values()) {
            // TODO: Maybe don't?
            if (!testResult.passed) {
              failingTestFiles.add(testResult.file);
              failedCoverageMap.merge(testResult.coverage);
            }
          }
          const failedCoverage: Coverage = failedCoverageMap.data;
          const statements: StatementBlock[] = [];
          console.log('failing coverage')
          const locations: Location[] = [];
          for(const [coveragePath, fileCoverage] of Object.entries(failedCoverage)) {
            console.log(coveragePath)
            //console.log('failing', coveragePath, micromatch.isMatch(coveragePath, resolvedIgnoreGlob));
            if (micromatch.isMatch(coveragePath, resolvedIgnoreGlob)) {
              continue;
            }
            for(const statementCoverage of Object.values(fileCoverage.statementMap)) {
              locations.push({
                filePath: coveragePath,
                ...statementCoverage
              })
            }
          }
          const allNodePaths= await findAllNodePaths(cache, locations);
          const statementBlocks = identifyUnknownInstruction(allNodePaths, false);
          for(const statement of statementBlocks) {
            statements.push({
              statements: statement
            })
          }

          const allLocations: Map<string, Location> = new Map();
          const stack: StatementInformation[]= [];
          for(const block of statementBlocks) {
            stack.push(...block);
          }

          while(stack.length > 0) {
            const popped = stack.pop()!;
            const key = locationToKeyIncludingEnd(popped.filePath, popped.location);
            allLocations.set(key, { filePath: popped.filePath, ...popped.location });
            stack.push(...popped.innerStatements);
            for(const instructionHolder of popped.instructionHolders) {
              for(const [filePath, locations] of Object.entries(instructionHolder.instruction.mutationResults.locations)) {
                for(const location of locations) {
                  const instructionKey = locationToKeyIncludingEnd(filePath, location);
                  allLocations.set(instructionKey, {...location, filePath});
                }
              }
            }
          }

          // TODO: This includes istanbul coverage which isn't even necessarily covered. But we have to keep it for now cause mapToIstanbul assumes that they're included in the evaluations
          const nodePaths = await findAllNodePaths(cache, [...allLocations.values(), ...locations]);
          for(const nodePath of nodePaths) {
            const key = locationToKeyIncludingEnd(nodePath.filePath, nodePath.node.loc!);
            const totalNodes = nodePath.node[TOTAL_NODES];
            if (locationEvaluations.has(key)) {
              const locationEvaluation = locationEvaluations.get(key)!;
              if (totalNodes > locationEvaluation.totalNodes) {
                locationEvaluation.totalNodes = totalNodes;
              }
            } else {
              locationEvaluations.set(key, stubLocationEvaluation({
                filePath: nodePath.filePath,
                ...nodePath.node.loc!
              }, totalNodes));  
            }
          }

          if (statements.length > 0) {
            console.log('Pushing instruction')
            instructionQueue.push(createInstructionHolder(new DeleteStatementInstruction(statements, RETRIES), false));  
          } else {
            console.log('Skipping instruction');
          }
        } else {
          const mutationEvaluation = evaluateNewMutation(
            firstTesterResults,
            tester,
            previousInstruction,
            previousRunWasPartial
          );
  
          if (previousRunWasPartial && !mutationEvaluation.crashed) {
            const testsToBeRerun = [...firstTesterResults.testResults.values()].map(result => result.file);
            previousRunWasPartial = false;
            console.log('proceeding with full test run');
            return testsToBeRerun;
          }
  
          await resetMutationsInInstruction(previousInstruction);
 
          await analyzeEvaluation(mutationEvaluation, cache); 
        }
        
        const rerun = await runInstruction(tester, cache);
        if (!rerun) {
          return;
        }
        if (allowPartialTestRuns) {
          console.log('Running partial test run');
          previousRunWasPartial = true;
          return [...failingTestFiles];
        } else {
          // TODO: DRY
          const testsToBeRerun = [...firstTesterResults.testResults.values()].map(result => result.file);
          return testsToBeRerun;
        }
      },
      async exit(tester: FinalTesterResults) {
        if (finished) {
          return { rerun: false, allow: false };
        }
        if (firstRun) {
          return { rerun: false, allow: false, };
        }
        const mutationEvaluation: MutationEvaluation = {
          type: previousInstruction.instruction.type,
          atomicMutation: previousInstruction.instruction.atomicMutation,
          totalNodes: previousInstruction.instruction.totalNodes,
          testsWorsened: null,
          testsImproved: null,
          stackEvaluation: null,
          errorsChanged: null,
          crashed: true,
          partial: previousRunWasPartial,
        };

        if (previousRunWasPartial) {
          previousRunWasPartial = false;
        }

        const cache = createAstCache(babelOptions);
        if (previousInstruction !== null) {
          await resetMutationsInInstruction(previousInstruction);
        }
        await analyzeEvaluation(mutationEvaluation, cache);

        // TODO: Would be better if the exit hook could be told which tests to rerun. Maybe :P
        const rerun = await runInstruction(tester, cache);
        
        return { rerun, allow: true };
      },
      complete: async (tester: FinalTesterResults) => {
        console.log('complete');
        console.log(`Mutations attempted: ${mutationsAttempted}`)
        Promise.all(
          [...originalPathToCopyPath.values()].map(copyPath => unlink(copyPath)),
        ).then(() => rmdir(copyTempDir));
        
        const mappedLocationEvaluations = mapToIstanbul ? mapLocationEvaluationsToIstanbulCoverage(locationEvaluations, tester.coverage) : locationEvaluations;
        const locationEvaluationsThatArentEmpty: Map<string, LocationEvaluation> = new Map();
        for(const [key, value] of mappedLocationEvaluations) {
          if (value.evaluations.length > 0) {
            locationEvaluationsThatArentEmpty.set(key, value);
          }
        }
        const faults = mutationEvalatuationMapToFaults(locationEvaluationsThatArentEmpty);
        await Promise.all([recordFaults(faultFilePath, faults), reportFaults(faults)]);
      },
    },
  };
};

export default createPlugin;
