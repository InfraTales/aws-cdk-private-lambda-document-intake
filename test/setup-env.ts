// Lambda sets these before the handler module loads, so the tests must too.
Object.assign(process.env, {
  TABLE_NAME: 'documents',
  BUCKET_NAME: 'documents-bucket',
  MAX_BYTES: String(10 * 1024 * 1024),
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});
