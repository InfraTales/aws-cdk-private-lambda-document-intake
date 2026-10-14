import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { S3Event } from 'aws-lambda';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

// Check the real file type from its first bytes, not from the name or header the client sent.
const SIGNATURES: Record<string, number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const documentId = key.split('/').pop()!;

    const head = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: record.s3.object.versionId,
      Range: 'bytes=0-7', // 8 bytes is enough; no need to download the file
    }));
    const bytes = await head.Body!.transformToByteArray();
    const expected = SIGNATURES[head.ContentType ?? ''];
    const valid = !!expected && expected.every((b, i) => bytes[i] === b);

    try {
      // S3 can deliver the same event twice. Only a PENDING record moves forward.
      await db.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME,
        Key: { pk: `DOC#${documentId}` },
        ConditionExpression: '#s = :pending',
        UpdateExpression: 'SET #s = :status, sizeBytes = :size, checkedAt = :now REMOVE expiresAt',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':pending': 'PENDING',
          ':status': valid ? 'VALIDATED' : 'REJECTED',
          ':size': record.s3.object.size,
          ':now': new Date().toISOString(),
        },
      }));
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        console.log(JSON.stringify({ msg: 'duplicate or unknown event, skipped', documentId }));
        continue;
      }
      throw err; // real failure: Lambda retries, then the on-failure queue
    }
  }
};
