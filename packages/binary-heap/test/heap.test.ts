import { leftIndex, parentIndex, rightIndex, swap } from '../src/index';
import Heap from '../src/index';

describe('heap', () => {
  it('swap', () => {
    const arr = [1,2,3];
    swap(arr, 0, 2);
    expect(arr).to.be.deep.equal([3, 2, 1]);
  });
  it('leftIndex', () => {
    expect(leftIndex(0)).to.be.equal(1);
    expect(leftIndex(1)).to.be.equal(3);
    expect(leftIndex(2)).to.be.equal(5);
    expect(leftIndex(3)).to.be.equal(7);
    expect(leftIndex(4)).to.be.equal(9);
    expect(leftIndex(5)).to.be.equal(11);
    expect(leftIndex(6)).to.be.equal(13);
  });
  it('rightIndex', () => {
    expect(rightIndex(0)).to.be.equal(2);
    expect(rightIndex(1)).to.be.equal(4);
    expect(rightIndex(2)).to.be.equal(6);
    expect(rightIndex(3)).to.be.equal(8);
    expect(rightIndex(4)).to.be.equal(10);
    expect(rightIndex(5)).to.be.equal(12);
    expect(rightIndex(6)).to.be.equal(14);
  })
  it('parentIndex', () => {
    expect(parentIndex(1)).to.be.equal(0);
    expect(parentIndex(2)).to.be.equal(0);
    expect(parentIndex(3)).to.be.equal(1);
    expect(parentIndex(4)).to.be.equal(1);
    expect(parentIndex(5)).to.be.equal(2);
    expect(parentIndex(6)).to.be.equal(2);
  });

  const testCases: [string, number[]][] = [
    ['empty', []],
    ['single element', [0]],
    ['already sorted', [0,1,2,3,4]],
    ['already sorted, repeating elements', [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]],
    ['unsorted, multi-digit', [3,2,10,500,0,999,5,]],
    ['unsorted, repeating elements', [3, 3, 1, 1, 5, 5, 0, 0]],
    ['large, unsorted, negative numbers, mutli-digit, repeating elements', [1,2,3,4,12,31,1,-1,3,6,7,2, -40,1,2,2,22,2,1,5,19, -1, -1, -100, -2,-2,-5]]
  ];
  const compareFns: [string, ((a, b) => number) | undefined][] = [
    ['default', undefined],
    ['reverse order', (a, b) => b - a]
  ];
  for(const [name, compareFn] of compareFns) {
    describe(name, () => {
      it('length', () => {
        expect(new Heap(compareFn, [1,2,3,4]).length).to.be.equal(4);
      });

      it('constructed', () => {
        const arr = [4,2,1,-5,3];
        const sorted = [...arr].sort(compareFn);
        const heapArr = [...new Heap(compareFn, arr)];
        expect(heapArr).to.be.deep.equal(sorted);
      });

      describe('push and spread', () => {
        for(const [testName, arr] of testCases) {
          it(testName, () => {
            const sorted = [...arr].sort(compareFn);
            const heap = new Heap(compareFn);
            heap.push(...arr);
            const heapArr = [...heap];
            expect(heapArr).to.be.deep.equal(sorted);
          })
        }
      });

      describe('pop', () => {
        const testSplice = (i: number | undefined) => {
          it(`${i}`, () => {
            const removalArr = [-1,2,3,1,0];
            const sortedArr = [...removalArr].sort(compareFn);
            const heap = new Heap(compareFn, removalArr);
            heap.pop(i);
            if (i === undefined) {
              sortedArr.pop();
            } else {
              sortedArr.splice(i, 1);
            }
          });
        }
        testSplice(undefined);
        for(let i = 0; i < 5; i++) {
          testSplice(i);
        }
      })
    });
  }
});