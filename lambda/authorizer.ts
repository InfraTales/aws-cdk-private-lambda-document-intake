import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Keys are stored as SHA-256 hashes, so a table export never leaks a usable key.
export const handler = async (event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  const apiKey = event.headers?.['X-Api-Key'] ?? event.headers?.['x-api-key'];
  if (!apiKey) throw new Error('Unauthorized'); // API Gateway turns this into a 401

  const hash = createHash('sha256').update(apiKey).digest('hex');
  const { Item } = await db.send(new GetCommand({
    TableName: process.env.TABLE_NAME,
    Key: { pk: `APIKEY#${hash}` },
  }));
  if (!Item || Item.active !== true) throw new Error('Unauthorized');

  // The result is cached per key for 5 minutes, so allow the whole stage, not just this method.
  const [arnPrefix, stage] = event.methodArn.split('/');
  return {
    principalId: Item.clientId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'execute-api:Invoke', Resource: `${arnPrefix}/${stage}/*` }],
    },
    context: { clientId: Item.clientId },
  };
};
