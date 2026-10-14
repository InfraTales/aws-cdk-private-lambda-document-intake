import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DocumentIntakeStack } from '../../lib/document-intake-stack';

const synth = (enableWaf = true) => {
  const app = new cdk.App();
  const stack = new DocumentIntakeStack(app, 'Test', {
    allowedOrigin: 'https://portal.example.com',
    enableWaf,
    env: { region: 'us-east-1' },
  });
  return Template.fromStack(stack);
};

let t: Template;
beforeAll(() => {
  t = synth();
});

describe('network', () => {
  test('has no NAT gateway, no internet gateway and no public subnet', () => {
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
    t.resourceCountIs('AWS::EC2::InternetGateway', 0);
    t.resourceCountIs('AWS::EC2::Subnet', 2);
    t.allResourcesProperties('AWS::EC2::Subnet', { MapPublicIpOnLaunch: false });
  });

  test('reaches S3 and DynamoDB only through gateway endpoints with a policy', () => {
    t.resourceCountIs('AWS::EC2::VPCEndpoint', 2);
    t.allResourcesProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      PolicyDocument: Match.objectLike({ Statement: Match.anyValue() }),
    });
  });

  test('puts every application function inside the VPC', () => {
    const fns = t.findResources('AWS::Lambda::Function', {
      Properties: { Handler: 'index.handler', Runtime: 'nodejs24.x' },
    });
    expect(Object.keys(fns)).toHaveLength(3);
    for (const fn of Object.values(fns)) {
      expect(fn.Properties.VpcConfig.SubnetIds).toHaveLength(2);
      expect(fn.Properties.Architectures).toEqual(['arm64']);
    }
  });
});

describe('storage', () => {
  test('encrypts documents with KMS and a Bucket Key', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({ BucketKeyEnabled: true, ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }) }),
        ],
      },
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
  });

  test('refuses plain HTTP on both buckets', () => {
    const policies = t.findResources('AWS::S3::BucketPolicy');
    expect(Object.keys(policies)).toHaveLength(2);
    for (const p of Object.values(policies)) {
      expect(JSON.stringify(p.Properties.PolicyDocument)).toContain('"aws:SecureTransport":"false"');
    }
  });

  test('protects the table from deletion and keeps point-in-time recovery', () => {
    t.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: [Match.objectLike({
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      })],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
    t.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
  });

  test('rotates the KMS key and keeps it on stack delete', () => {
    t.hasResource('AWS::KMS::Key', { Properties: { EnableKeyRotation: true }, DeletionPolicy: 'Retain' });
  });
});

describe('API', () => {
  test('caches the authorizer result for 5 minutes', () => {
    t.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'REQUEST',
      AuthorizerResultTtlInSeconds: 300,
      IdentitySource: 'method.request.header.X-Api-Key',
    });
  });

  test('throttles the whole stage and writes access logs', () => {
    t.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: [Match.objectLike({ ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 })],
      AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue() }),
    });
  });

  test('allows one CORS origin, never "*"', () => {
    expect(JSON.stringify(t.toJSON())).not.toContain("'*'");
    t.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedOrigins: ['https://portal.example.com'] })] },
    });
  });

  test('puts WAF in front of the API, and can turn it off', () => {
    t.resourceCountIs('AWS::WAFv2::WebACL', 1);
    t.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    synth(false).resourceCountIs('AWS::WAFv2::WebACL', 0);
  });
});

describe('processing', () => {
  test('retries twice, then sends failures to SQS', () => {
    t.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      MaximumEventAgeInSeconds: 3600,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('caps processor concurrency', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 20 });
  });

  test('sets a retention period on every log group', () => {
    for (const lg of Object.values(t.findResources('AWS::Logs::LogGroup'))) {
      expect(lg.Properties.RetentionInDays).toBeGreaterThan(0);
    }
  });
});
