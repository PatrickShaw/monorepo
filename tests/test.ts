import { mockFunctions } from '../src/index';

const aObjectFunctionReturnValue = new Object();

const aObjectLiteral = {
  int: 1,
  str: '',
  undefined: undefined,
  null: null,
  returnObject: () => aObjectFunctionReturnValue,
  someRegex: /regex/,
};

const anArrayFunctionReturnValue = new Object();
const anArray = [
  function() {
    return anArrayFunctionReturnValue;
  },
  1,
  3,
  undefined,
  null,
  /regex/,
];

describe('only mocks functions', () => {
  it('with object literal', () => {
    const mockedObject = mockFunctions(aObjectLiteral);
    expect(mockedObject.returnObject()).not.toBe(aObjectLiteral.returnObject());
    Object.getOwnPropertyNames(mockedObject)
      .filter(key => key !== 'returnObject')
      .forEach(key => {
        expect(mockedObject[key]).toBe(aObjectLiteral[key]);
      });
  });
  it('with array', () => {
    const mockedArray = mockFunctions(anArray);
    const aFunction = mockedArray.shift();
    const originalFunction = anArray[0] as Function;
    expect(aFunction()).not.toBe(originalFunction());
    mockedArray.forEach((notAFunction, i) => {
      expect(notAFunction).toBe(anArray[i + 1]);
    });
  });
});

describe('can mock recursively', () => {
  it('with {...}', () => {
    const mockedObject = mockFunctions(
      {
        nested: aObjectLiteral,
      },
      { recursive: true }
    );
    expect(mockedObject.nested.returnObject()).not.toBe(aObjectLiteral.returnObject());
  });
  it('with array', () => {
    const mockedArray = mockFunctions([anArray], { recursive: true });
    const originalFunction = anArray[0] as Function;
    expect(mockedArray[0][0]()).not.toBe(originalFunction());
  });
});

it('only mocks recursively when recursive = true', () => {
  const mockedObject = mockFunctions({
    nested: aObjectLiteral,
  });
  expect(mockedObject.nested.returnObject()).toBe(aObjectLiteral.returnObject());
});

describe('invalid inputs', () => {
  [null, undefined].forEach(value => {
    it(`${value}`, () => {
      expect(() => mockFunctions(value)).toThrow(expect.any(Error));
    });
  });
});

describe('can mock the function', () => {
  it('new Array(...)', () => {
    const originalValue = new Object();
    const originalArray = new Array(1).fill(() => () => originalValue);
    const mockedArray = mockFunctions(originalArray);
    expect(mockedArray[0]()).not.toBe(originalArray[0]());
  });
});
