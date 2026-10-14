import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { S3Event } from 'aws-lambda';
import { handler } from '../../lambda/processor';

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]; // "%PDF-1.7"
const ZIP = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]; // a zip pretending to be a PDF

const s3Event = (key: string): S3Event =>
  ({
    Records: [{ s3: { bucket: { name: 'documents-bucket' }, object: { key, size: 2048, versionId: 'v1' } } }],
  }) as unknown as S3Event;

const objectBody = (bytes: number[], contentType: string) => ({
  ContentType: contentType,
  Body: { transformToByteArray: async () => Uint8Array.from(bytes) },
});

beforeEach(() => {
  ddb.reset();
  s3.reset();
});

test('reads only the first 8 bytes of the file', async () => {
  s3.on(GetObjectCommand).resolves(objectBody(PDF, 'application/pdf') as never);
  ddb.on(UpdateCommand).resolves({});
  await handler(s3Event('incoming/acme/doc-1'));

  expect(s3.commandCalls(GetObjectCommand)[0].args[0].input).toMatchObject({
    Key: 'incoming/acme/doc-1',
    VersionId: 'v1',
    Range: 'bytes=0-7',
  });
});

test('marks a real PDF as VALIDATED and clears the expiry', async () => {
  s3.on(GetObjectCommand).resolves(objectBody(PDF, 'application/pdf') as never);
  ddb.on(UpdateCommand).resolves({});
  await handler(s3Event('incoming/acme/doc-1'));

  const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
  expect(input.Key).toEqual({ pk: 'DOC#doc-1' });
  expect(input.ExpressionAttributeValues![':status']).toBe('VALIDATED');
  expect(input.UpdateExpression).toContain('REMOVE expiresAt');
  expect(input.ConditionExpression).toBe('#s = :pending');
});

test('marks a file as REJECTED when its bytes do not match the declared type', async () => {
  s3.on(GetObjectCommand).resolves(objectBody(ZIP, 'application/pdf') as never);
  ddb.on(UpdateCommand).resolves({});
  await handler(s3Event('incoming/acme/doc-1'));

  expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues![':status']).toBe('REJECTED');
});

test('decodes S3 keys that contain spaces', async () => {
  s3.on(GetObjectCommand).resolves(objectBody(PDF, 'application/pdf') as never);
  ddb.on(UpdateCommand).resolves({});
  await handler(s3Event('incoming/acme+corp/doc-1'));

  expect(s3.commandCalls(GetObjectCommand)[0].args[0].input.Key).toBe('incoming/acme corp/doc-1');
});

test('skips a duplicate event without failing', async () => {
  s3.on(GetObjectCommand).resolves(objectBody(PDF, 'application/pdf') as never);
  ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'already done', $metadata: {} }));
  await expect(handler(s3Event('incoming/acme/doc-1'))).resolves.toBeUndefined();
});

test('throws on a real error so Lambda retries and then sends the event to SQS', async () => {
  s3.on(GetObjectCommand).resolves(objectBody(PDF, 'application/pdf') as never);
  ddb.on(UpdateCommand).rejects(new Error('ProvisionedThroughputExceededException'));
  await expect(handler(s3Event('incoming/acme/doc-1'))).rejects.toThrow('ProvisionedThroughputExceededException');
});
