
import {
  AbstractSimpleInstructionFactory,
  InstructionFactory,
  deleteStatementFactory,
  forceConsequentFactory,
  forceAlternateFactory,  
  replaceIdentifierFactory,
  replaceBooleanFactory,
  replaceStringFactory,
  swapFunctionDeclarationParametersFactory,
  swapFunctionCallArgumentsFactory,
  replaceNumberFactory,
  replaceBinaryOrLogicalOperatorFactory,
  replaceAssignmentOperatorFactory,
  leftNullifyBinaryOrLogicalOperatorFactory,
  rightNullifyBinaryOrLogicalOperatorFactory,
} from '../src';
import { parse } from '@babel/parser';
type Code = string;
type Factory = AbstractSimpleInstructionFactory<any, any>;
type ExpectedInstructionCount = number;
type TestData = [Factory, Code, ExpectedInstructionCount];

const dataSet: TestData[] = [
  [deleteStatementFactory, 'const a = 0; const b = 0;', 2],
  [deleteStatementFactory, 'if(Math.random() > 0.5) {}', 0],
  [forceConsequentFactory, 'if(Math.random() > 0.5) { console.log("hello") }', 1],
  [forceConsequentFactory, 'if(true) { console.log("hello") }', 0],
  [forceAlternateFactory, 'if(Math.random() > 0.5) { console.log("hello")}', 1], 
  [forceAlternateFactory, 'if(false) { console.log("hello")}', 0],
  [replaceIdentifierFactory, 'const a = 0; a = 5; const b = a;', 0],
  [replaceIdentifierFactory, 'const a = 0; a = 5; const b = a; const c = a + b', 2],
  [replaceBooleanFactory, 'true', 1],
  [replaceStringFactory, '["hello", "my", "name", "is"]', 3],
  [swapFunctionDeclarationParametersFactory, 'const fn = (a, b, c) => {}', 2],
  [swapFunctionCallArgumentsFactory, 'fn(1, 2, 3)', 2],
  [replaceNumberFactory, '1;2;3;4;', 3],
  [replaceBinaryOrLogicalOperatorFactory, '1 + 2; 1 === 2;', 2],
  [replaceAssignmentOperatorFactory, '1 + 1; b += 2; a %= 3', 2],
  [leftNullifyBinaryOrLogicalOperatorFactory, '1 + 2 % 4;', 2],
  [rightNullifyBinaryOrLogicalOperatorFactory, '1 + 2 % 4', 2],
];

for(const [factory, code, expectedInstructionCount] of dataSet) {
  it(`${Object.getPrototypeOf(factory).constructor.name}`, () => {
    const filePath = '';

    const ast = parse(code);
    const astMap = new Map([[filePath, ast]]);
  
    const factoryWrapper = new InstructionFactory([factory]);
    factoryWrapper.setup(astMap);
    const instructions = [...factoryWrapper.createInstructions(astMap)];
  
    expect(instructions).toHaveLength(expectedInstructionCount);  
  })
}