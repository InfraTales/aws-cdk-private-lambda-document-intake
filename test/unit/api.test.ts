import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../lambda/api';

const ddb = mockClient(DynamoDBDocumentClient);

const request = (method: string, opts: { body?: object; documentId?: string; clientId?: string } = {}) =>
  ({
    httpMethod: method,
    body: opts.body ? JSON.stringify(opts.body) : null,
    pathParameters: opts.documentId ? { documentId: opts.documentId } : null,
    requestContext: { authorizer: { clientId: opts.clientId ?? 'acme' } },
  }) as unknown as APIGatewayProxyEvent;

// The upload policy is a base64 JSON document inside the presigned POST fields.
const decodePolicy = (fields: Record<string, string>) =>
  JSON.parse(Buffer.from(fields.Policy, 'base64').toString('utf8'));

beforeEach(() => ddb.reset());

describe('POST /documents', () => {
  test('stores a PENDING record that expires if nobody uploads', async () => {
    ddb.on(PutCommand).resolves({});
    const res = await handler(request('POST', { body: { fileName: 'passport.pdf', contentType: 'application/pdf' } }));
    expect(res.statusCode).toBe(201);

    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item).toMatchObject({ clientId: 'acme', status: 'PENDING', fileName: 'passport.pdf' });
    expect(item.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  test('returns an upload form locked to one key, one content type and 10 MB', async () => {
    ddb.on(PutCommand).resolves({});
    const res = await handler(request('POST', { body: { fileName: 'a.png', contentType: 'image/png' } }));
    const { documentId, upload } = JSON.parse(res.body);

    expect(upload.url).toBe('https://documents-bucket.s3.us-east-1.amazonaws.com/');
    expect(upload.fields.bucket).toBe('documents-bucket');
    expect(upload.fields.key).toBe(`incoming/acme/${documentId}`);

    const policy = decodePolicy(upload.fields);
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['content-length-range', 1, 10 * 1024 * 1024],
        ['eq', '$Content-Type', 'image/png'],
      ]),
    );
    const expiresInSeconds = (Date.parse(policy.expiration) - Date.now()) / 1000;
    expect(expiresInSeconds).toBeLessThanOrEqual(300);
  });
});

describe('GET /documents/{id}', () => {
  test('returns the status to the client that owns the document', async () => {
    ddb.on(GetCommand).resolves({ Item: { clientId: 'acme', status: 'VALIDATED', fileName: 'a.pdf', createdAt: 'x' } });
    const res = await handler(request('GET', { documentId: 'doc-1' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ documentId: 'doc-1', status: 'VALIDATED' });
  });

  test("answers 404 for another client's document, same as for a missing one", async () => {
    ddb.on(GetCommand).resolves({ Item: { clientId: 'someone-else', status: 'VALIDATED' } });
    const theirs = await handler(request('GET', { documentId: 'doc-1' }));

    ddb.on(GetCommand).resolves({});
    const missing = await handler(request('GET', { documentId: 'doc-2' }));

    expect(theirs.statusCode).toBe(404);
    expect(theirs.body).toBe(missing.body);
  });
});
