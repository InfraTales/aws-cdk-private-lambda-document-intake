/**
 * Runs the whole upload path through the real handler code:
 * authorizer -> POST /documents -> client uploads to S3 -> S3 event -> processor -> GET status.
 * S3 and DynamoDB are small in-memory fakes that follow the real API rules this code relies on.
 */
import { createHash } from 'crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEvent, APIGatewayRequestAuthorizerEvent, S3Event } from 'aws-lambda';
import { handler as api } from '../../lambda/api';
import { handler as authorize } from '../../lambda/authorizer';
import { handler as process_ } from '../../lambda/processor';

type Item = Record<string, any>;
const table = new Map<string, Item>();
const bucket = new Map<string, { bytes: Uint8Array; contentType: string; versionId: string }>();

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

function installFakes() {
  ddb.on(GetCommand).callsFake(({ Key }) => ({ Item: table.get(Key.pk) }));
  ddb.on(PutCommand).callsFake(({ Item }) => {
    table.set(Item.pk, { ...Item });
    return {};
  });
  // Supports exactly what the processor sends: a status condition, SET and REMOVE.
  ddb.on(UpdateCommand).callsFake(({ Key, ExpressionAttributeValues: v }) => {
    const item = table.get(Key.pk);
    if (!item || item.status !== v[':pending']) {
      throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
    }
    Object.assign(item, { status: v[':status'], sizeBytes: v[':size'], checkedAt: v[':now'] });
    delete item.expiresAt;
    return {};
  });
  s3.on(GetObjectCommand).callsFake(({ Key, Range }) => {
    const obj = bucket.get(Key);
    if (!obj) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(Range)!.map(Number);
    return {
      ContentType: obj.contentType,
      Body: { transformToByteArray: async () => obj.bytes.slice(start, end + 1) },
    };
  });
}

// --- the actors -------------------------------------------------------------

const API_KEY = 'acme-live-key-123';
const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc123/v1/POST/documents';

async function callApi(method: 'GET' | 'POST', opts: { body?: object; documentId?: string; key?: string }) {
  // API Gateway runs the authorizer first and passes its context to the function.
  const auth = await authorize({
    methodArn: METHOD_ARN,
    headers: { 'X-Api-Key': opts.key ?? API_KEY },
  } as unknown as APIGatewayRequestAuthorizerEvent);
  const res = await api({
    httpMethod: method,
    body: opts.body ? JSON.stringify(opts.body) : null,
    pathParameters: opts.documentId ? { documentId: opts.documentId } : null,
    requestContext: { authorizer: auth.context },
  } as unknown as APIGatewayProxyEvent);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/** What S3 does with a presigned POST: check the signed policy, then store the object. */
function uploadWithPresignedPost(upload: { fields: Record<string, string> }, bytes: Uint8Array, contentType: string) {
  const policy = JSON.parse(Buffer.from(upload.fields.Policy, 'base64').toString('utf8'));
  for (const condition of policy.conditions) {
    if (Array.isArray(condition) && condition[0] === 'content-length-range') {
      if (bytes.length < condition[1] || bytes.length > condition[2]) return 400;
    }
    if (Array.isArray(condition) && condition[0] === 'eq' && condition[1] === '$Content-Type') {
      if (contentType !== condition[2]) return 403;
    }
  }
  bucket.set(upload.fields.key, { bytes, contentType, versionId: `v${bucket.size + 1}` });
  return 204;
}

function s3EventFor(key: string): S3Event {
  const obj = bucket.get(key)!;
  return {
    Records: [{
      s3: {
        bucket: { name: 'documents-bucket' },
        // S3 URL-encodes keys in events, with "+" for spaces.
        object: { key: encodeURIComponent(key).replace(/%2F/g, '/').replace(/%20/g, '+'), size: obj.bytes.length, versionId: obj.versionId },
      },
    }],
  } as unknown as S3Event;
}

const pdf = (size = 4096) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
  return bytes;
};

// --- the tests --------------------------------------------------------------

beforeEach(() => {
  table.clear();
  bucket.clear();
  ddb.reset();
  s3.reset();
  installFakes();
  const hash = createHash('sha256').update(API_KEY).digest('hex');
  table.set(`APIKEY#${hash}`, { pk: `APIKEY#${hash}`, clientId: 'acme', active: true });
});

test('a real PDF goes from upload request to VALIDATED', async () => {
  const created = await callApi('POST', { body: { fileName: 'passport.pdf', contentType: 'application/pdf' } });
  expect(created.status).toBe(201);
  const { documentId, upload } = created.body;

  expect((await callApi('GET', { documentId })).body.status).toBe('PENDING');

  expect(uploadWithPresignedPost(upload, pdf(), 'application/pdf')).toBe(204);
  await process_(s3EventFor(upload.fields.key));

  const status = await callApi('GET', { documentId });
  expect(status).toEqual({
    status: 200,
    body: expect.objectContaining({ documentId, status: 'VALIDATED', fileName: 'passport.pdf' }),
  });
  // A finished record must not expire.
  expect(table.get(`DOC#${documentId}`)!.expiresAt).toBeUndefined();
});

test('a zip renamed to .pdf ends up REJECTED', async () => {
  const { body } = await callApi('POST', { body: { fileName: 'invoice.pdf', contentType: 'application/pdf' } });
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 1, 2, 3]);

  uploadWithPresignedPost(body.upload, zip, 'application/pdf');
  await process_(s3EventFor(body.upload.fields.key));

  expect((await callApi('GET', { documentId: body.documentId })).body.status).toBe('REJECTED');
});

test('S3 refuses uploads that break the signed policy', async () => {
  const { body } = await callApi('POST', { body: { fileName: 'a.pdf', contentType: 'application/pdf' } });

  expect(uploadWithPresignedPost(body.upload, pdf(11 * 1024 * 1024), 'application/pdf')).toBe(400); // too big
  expect(uploadWithPresignedPost(body.upload, pdf(), 'text/html')).toBe(403); // wrong type
  expect(bucket.size).toBe(0);
});

test('a duplicate S3 event changes nothing', async () => {
  const { body } = await callApi('POST', { body: { fileName: 'a.pdf', contentType: 'application/pdf' } });
  uploadWithPresignedPost(body.upload, pdf(), 'application/pdf');
  const event = s3EventFor(body.upload.fields.key);

  await process_(event);
  const firstCheck = table.get(`DOC#${body.documentId}`)!.checkedAt;
  await process_(event); // S3 delivers at least once

  expect(table.get(`DOC#${body.documentId}`)!.checkedAt).toBe(firstCheck);
});

test("another client can't read the status, and a wrong key gets no access at all", async () => {
  const { body } = await callApi('POST', { body: { fileName: 'a.pdf', contentType: 'application/pdf' } });

  const otherHash = createHash('sha256').update('globex-key').digest('hex');
  table.set(`APIKEY#${otherHash}`, { pk: `APIKEY#${otherHash}`, clientId: 'globex', active: true });

  expect((await callApi('GET', { documentId: body.documentId, key: 'globex-key' })).status).toBe(404);
  await expect(callApi('GET', { documentId: body.documentId, key: 'guessed-key' })).rejects.toThrow('Unauthorized');
});

test('a file name with spaces still matches its record', async () => {
  // The object key uses the client ID, so this checks the URL decoding path with a spaced client ID.
  const hash = createHash('sha256').update('spaced-key').digest('hex');
  table.set(`APIKEY#${hash}`, { pk: `APIKEY#${hash}`, clientId: 'acme corp', active: true });

  const { body } = await callApi('POST', { body: { fileName: 'my file.pdf', contentType: 'application/pdf' }, key: 'spaced-key' });
  uploadWithPresignedPost(body.upload, pdf(), 'application/pdf');
  await process_(s3EventFor(body.upload.fields.key));

  expect((await callApi('GET', { documentId: body.documentId, key: 'spaced-key' })).body.status).toBe('VALIDATED');
});
