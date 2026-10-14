import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const { TABLE_NAME, BUCKET_NAME, MAX_BYTES } = process.env;

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const clientId = event.requestContext.authorizer?.clientId as string;

  if (event.httpMethod === 'POST') {
    // Body shape is already validated by the API Gateway JSON schema model.
    const { fileName, contentType } = JSON.parse(event.body ?? '{}');
    const documentId = randomUUID();
    const key = `incoming/${clientId}/${documentId}`;

    await db.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `DOC#${documentId}`,
        clientId,
        fileName,
        contentType,
        status: 'PENDING',
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600, // TTL if the upload never happens
      },
    }));

    // The file goes straight from the client to S3. Lambda never touches the bytes.
    const upload = await createPresignedPost(s3, {
      Bucket: BUCKET_NAME!,
      Key: key,
      Expires: 300,
      Conditions: [
        ['content-length-range', 1, Number(MAX_BYTES)],
        ['eq', '$Content-Type', contentType],
      ],
      Fields: { 'Content-Type': contentType },
    });

    return json(201, { documentId, upload });
  }

  const documentId = event.pathParameters?.documentId;
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: `DOC#${documentId}` } }));

  // Same 404 for "missing" and "someone else's": don't leak which IDs exist.
  if (!Item || Item.clientId !== clientId) return json(404, { message: 'Not found' });
  return json(200, { documentId, status: Item.status, fileName: Item.fileName, createdAt: Item.createdAt });
};
