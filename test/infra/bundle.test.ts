/**
 * Loads each bundled Lambda file the way the Lambda runtime does.
 * Catches "Cannot find module" before it reaches AWS: CDK leaves @aws-sdk/* out of
 * bundles by default, and @aws-sdk/s3-presigned-post is not in the Lambda runtime.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { DocumentIntakeStack } from '../../lib/document-intake-stack';

test('every bundled function loads and exports a handler', () => {
  const app = new cdk.App({ outdir: fs.mkdtempSync(path.join(require('os').tmpdir(), 'cdk-bundle-')) });
  new DocumentIntakeStack(app, 'Bundle', {
    allowedOrigin: 'https://portal.example.com',
    enableWaf: false,
    env: { region: 'us-east-1' },
  });
  const assembly = app.synth();

  const template = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'Bundle.template.json'), 'utf8'));
  const appFunctions = Object.values<any>(template.Resources).filter(
    (r) => r.Type === 'AWS::Lambda::Function' && r.Properties.VpcConfig !== undefined, // our functions are the only ones in the VPC
  );
  expect(appFunctions).toHaveLength(3);

  for (const fn of appFunctions) {
    // CDK writes each bundle to asset.<hash>, and the hash is the S3 key without ".zip".
    const hash = fn.Properties.Code.S3Key.replace('.zip', '');
    const assetDir = path.join(assembly.directory, `asset.${hash}`);
    const mod = require(path.join(assetDir, 'index.js'));
    expect(typeof mod.handler).toBe('function');
  }
});
