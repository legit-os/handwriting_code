function multiply(left: number, right: number): number {
  return left * right;
}

if (multiply(6, 7) !== 42) throw new Error('TypeScript assertion failed');
console.log('TypeScript smoke test passed');
