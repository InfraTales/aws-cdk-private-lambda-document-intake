import { createHash } from 'crypto';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { handler } from '../../lambda/authorizer';

const ddb = mockClient(DynamoDBDocumentClient);
const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc123/v1/POST/documents';

const eventWithKey = (key?: string) =>
  ({ methodArn: METHOD_ARN, headers: key ? { 'X-Api-Key': key } : {} }) as unknown as APIGatewayRequestAuthorizerEvent;

beforeEach(() => ddb.reset());

test('rejects a request with no API key', async () => {
  await expect(handler(eventWithKey())).rejects.toThrow('Unauthorized');
  expect(ddb.calls()).toHaveLength(0);
});

test('looks the key up by its SHA-256 hash, never the raw key', async () => {
  ddb.on(GetCommand).resolves({});
  await expect(handler(eventWithKey('secret-key'))).rejects.toThrow('Unauthorized');

  const hash = createHash('sha256').update('secret-key').digest('hex');
  expect(ddb.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({ pk: `APIKEY#${hash}` });
});

test('rejects a key that exists but is turned off', async () => {
  ddb.on(GetCommand).resolves({ Item: { clientId: 'acme', active: false } });
  await expect(handler(eventWithKey('secret-key'))).rejects.toThrow('Unauthorized');
});

test('allows the whole stage for a valid key, so the cached result works for every route', async () => {
  ddb.on(GetCommand).resolves({ Item: { clientId: 'acme', active: true } });
  const result = await handler(eventWithKey('secret-key'));

  expect(result.principalId).toBe('acme');
  expect(result.context).toEqual({ clientId: 'acme' });
  expect(result.policyDocument.Statement[0]).toMatchObject({
    Effect: 'Allow',
    Resource: 'arn:aws:execute-api:us-east-1:123456789012:abc123/v1/*',
  });
});
