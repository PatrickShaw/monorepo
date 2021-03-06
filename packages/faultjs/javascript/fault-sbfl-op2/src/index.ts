import type { Stats } from '@fault/types';

export const op2 = (codeElementTestStateCounts: Stats, totalTestStateCounts: Stats) => {
  return (
    codeElementTestStateCounts.failed -
    codeElementTestStateCounts.passed / (totalTestStateCounts.passed + 1)
  );
};
export default op2;
