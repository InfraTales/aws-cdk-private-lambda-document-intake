#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DocumentIntakeStack } from '../lib/document-intake-stack';

const app = new cdk.App();

new DocumentIntakeStack(app, 'DocumentIntake', {
  allowedOrigin: app.node.tryGetContext('allowedOrigin'),
  enableWaf: app.node.tryGetContext('enableWaf') !== false && app.node.tryGetContext('enableWaf') !== 'false',
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any unsuppressed AWS Solutions finding.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
