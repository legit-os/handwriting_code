import assert from 'node:assert/strict';

const multiply = (left, right) => left * right;
assert.equal(multiply(6, 7), 42);
console.log('JavaScript smoke test passed');
