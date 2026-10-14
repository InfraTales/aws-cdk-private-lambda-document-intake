module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  // The infra tests bundle three Lambda functions with esbuild.
  testTimeout: 120000,
  setupFiles: ['<rootDir>/test/setup-env.ts'],
};
