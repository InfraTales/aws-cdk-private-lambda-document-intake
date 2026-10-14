import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface DocumentIntakeStackProps extends cdk.StackProps {
  /** Browser origin allowed to call the API (CORS). Never "*" for a document API. */
  allowedOrigin: string;
  /** AWS WAF in front of the API: about $7/month plus requests. On by default. */
  enableWaf: boolean;
}

/**
 * Document intake for sensitive uploads (KYC, contracts) with Lambdas in
 * isolated subnets: no NAT gateway, no internet route, gateway endpoints only.
 */
export class DocumentIntakeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DocumentIntakeStackProps) {
    super(scope, id, props);

    // ---------- Network: isolated subnets, zero NAT, gateway endpoints only ----------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
      restrictDefaultSecurityGroup: true, // Security Hub EC2.2
      flowLogs: {
        rejected: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'VpcFlowLogs', { retention: logs.RetentionDays.ONE_MONTH }),
          ),
          trafficType: ec2.FlowLogTrafficType.REJECT, // only rejected traffic: cheap, still useful
        },
      },
    });

    const s3Endpoint = vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    const ddbEndpoint = vpc.addGatewayEndpoint('DynamoDbEndpoint', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });

    // No route to the internet exists, so 443 egress can only reach the endpoints above.
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'Document intake Lambdas: HTTPS to VPC endpoints only',
      allowAllOutbound: false,
    });
    lambdaSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to S3/DynamoDB gateway endpoints');

    // ---------- Keys and storage ----------
    const key = new kms.Key(this, 'DataKey', {
      alias: 'alias/document-intake',
      description: 'Encrypts documents, metadata and failure queue',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const accessLogs = new s3.Bucket(this, 'AccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED, // S3 server access logs can't target SSE-KMS buckets
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const documents = new s3.Bucket(this, 'Documents', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true, // far fewer KMS requests
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true, // Security Hub S3.5
      versioned: true,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'documents/',
      cors: [{
        allowedMethods: [s3.HttpMethods.POST],
        allowedOrigins: [props.allowedOrigin],
        allowedHeaders: ['*'],
        maxAge: 3000,
      }],
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
        { transitions: [{ storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) }] },
        { noncurrentVersionExpiration: cdk.Duration.days(30) },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const table = new dynamodb.TableV2(this, 'DocumentsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(key),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      timeToLiveAttribute: 'expiresAt', // abandoned PENDING records clean themselves up
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Data perimeter: from inside this VPC, the endpoints only reach OUR bucket and table.
    s3Endpoint.addToPolicy(new iam.PolicyStatement({
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [documents.arnForObjects('incoming/*')],
    }));
    ddbEndpoint.addToPolicy(new iam.PolicyStatement({
      principals: [new iam.AnyPrincipal()],
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [table.tableArn],
    }));

    // ---------- Functions: arm64, bounded logs, isolated subnets ----------
    const fnDefaults: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      tracing: lambda.Tracing.DISABLED,
      // Bundle every dependency. CDK leaves out @aws-sdk/* by default, but the Lambda
      // runtime does not ship @aws-sdk/s3-presigned-post, so the API function would fail.
      bundling: { minify: true, sourceMap: false, target: 'node24', externalModules: [] },
    };
    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });

    const authorizerFn = new nodejs.NodejsFunction(this, 'Authorizer', {
      ...fnDefaults,
      entry: path.join(__dirname, '../lambda/authorizer.ts'),
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      logGroup: logGroup('Authorizer'),
      environment: { TABLE_NAME: table.tableName },
    });
    table.grant(authorizerFn, 'dynamodb:GetItem');

    const apiFn = new nodejs.NodejsFunction(this, 'Api', {
      ...fnDefaults,
      entry: path.join(__dirname, '../lambda/api.ts'),
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      logGroup: logGroup('Api'),
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: documents.bucketName,
        MAX_BYTES: String(10 * 1024 * 1024),
      },
    });
    table.grant(apiFn, 'dynamodb:GetItem', 'dynamodb:PutItem');
    // The presigned POST is signed with this role, so it needs exactly PutObject + the data key.
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [documents.arnForObjects('incoming/*')] }));
    key.grant(apiFn, 'kms:GenerateDataKey');

    // Holds event metadata (bucket, key, error), never document bytes: SSE-SQS is enough and costs nothing.
    const failures = new sqs.Queue(this, 'ProcessingFailures', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    const processorFn = new nodejs.NodejsFunction(this, 'Processor', {
      ...fnDefaults,
      entry: path.join(__dirname, '../lambda/processor.ts'),
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: 20, // protects DynamoDB and the bill from an upload flood
      logGroup: logGroup('Processor'),
      environment: { TABLE_NAME: table.tableName },
      retryAttempts: 2,
      maxEventAge: cdk.Duration.hours(1),
      onFailure: new destinations.SqsDestination(failures), // async only; replaces a DLQ
    });
    table.grant(processorFn, 'dynamodb:UpdateItem');
    processorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [documents.arnForObjects('incoming/*')],
    }));
    key.grant(processorFn, 'kms:Decrypt');
    documents.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(processorFn),
      { prefix: 'incoming/' },
    );

    // ---------- API: REST, cached authorizer, stage throttling, access logs ----------
    const apiLogs = new logs.LogGroup(this, 'ApiAccessLogs', { retention: logs.RetentionDays.ONE_MONTH });
    const api = new apigateway.RestApi(this, 'DocumentApi', {
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      cloudWatchRole: true,
      deployOptions: {
        stageName: 'v1',
        throttlingRateLimit: 50, // enforced for every caller, no usage plan needed
        throttlingBurstLimit: 100,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [props.allowedOrigin],
        allowMethods: ['GET', 'POST'],
        allowHeaders: ['Content-Type', 'X-Api-Key'],
      },
    });

    const authorizer = new apigateway.RequestAuthorizer(this, 'ApiKeyAuthorizer', {
      handler: authorizerFn,
      identitySources: [apigateway.IdentitySource.header('X-Api-Key')],
      resultsCacheTtl: cdk.Duration.minutes(5), // one DynamoDB read per key per 5 minutes
    });

    const validator = api.addRequestValidator('Validator', { validateRequestBody: true, validateRequestParameters: true });
    const uploadModel = api.addModel('UploadRequest', {
      contentType: 'application/json',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['fileName', 'contentType'],
        additionalProperties: false,
        properties: {
          fileName: { type: apigateway.JsonSchemaType.STRING, minLength: 1, maxLength: 200 },
          contentType: { type: apigateway.JsonSchemaType.STRING, enum: ['application/pdf', 'image/png', 'image/jpeg'] },
        },
      },
    });

    const integration = new apigateway.LambdaIntegration(apiFn);
    const docsResource = api.root.addResource('documents');
    docsResource.addMethod('POST', integration, {
      authorizer,
      requestValidator: validator,
      requestModels: { 'application/json': uploadModel },
    });
    docsResource.addResource('{documentId}').addMethod('GET', integration, {
      authorizer,
      requestValidator: validator,
      requestParameters: { 'method.request.path.documentId': true },
    });

    // ---------- WAF: managed rules + per-IP rate limit ----------
    if (props.enableWaf) {
      const acl = new wafv2.CfnWebACL(this, 'ApiWaf', {
        scope: 'REGIONAL',
        defaultAction: { allow: {} },
        visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'document-api', sampledRequestsEnabled: true },
        rules: [
          {
            name: 'AWSManagedCommon',
            priority: 0,
            overrideAction: { none: {} },
            statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
            visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'common', sampledRequestsEnabled: true },
          },
          {
            name: 'RatePerIp',
            priority: 1,
            action: { block: {} },
            statement: { rateBasedStatement: { limit: 300, aggregateKeyType: 'IP' } }, // per 5 minutes
            visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'rate', sampledRequestsEnabled: true },
          },
        ],
      });
      new wafv2.CfnWebACLAssociation(this, 'ApiWafAssociation', {
        resourceArn: api.deploymentStage.stageArn,
        webAclArn: acl.attrArn,
      });
    }

    // ---------- Alarms that mean "a human should look" ----------
    new cloudwatch.Alarm(this, 'FailedDocumentsAlarm', {
      metric: failures.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'A document failed processing after retries',
    });
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      metric: api.metricServerError({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });

    // ---------- cdk-nag: only by-design findings are acknowledged, each with a reason ----------
    const ack = (scope: Construct, id: string, reason: string) => cdk.Validations.of(scope).acknowledge({ id, reason });
    ack(this, 'AwsSolutions::AwsSolutions-IAM5[Resource::<Documents7E5B2978.Arn>/incoming/*]',
      'Object-level access is scoped to the incoming/ prefix; object keys are generated per upload.');
    ack(this, 'AwsSolutions::AwsSolutions-SQS3', 'This queue is the Lambda on-failure destination itself.');
    ack(this, 'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs]',
      'Account-level role API Gateway requires for execution/access logging.');
    for (const policy of ['AWSLambdaBasicExecutionRole', 'AWSLambdaVPCAccessExecutionRole']) {
      ack(this, `AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/${policy}]`,
        'AWS-maintained Lambda execution policies; the VPC ENI actions require Resource "*" by design.');
    }
    ack(this, 'AwsSolutions::AwsSolutions-COG4', 'Machine-to-machine API: callers use hashed API keys checked by a Lambda authorizer, not end-user Cognito sessions.');
  }
}
