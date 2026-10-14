/**
 * Creates an API key for a client and stores only its SHA-256 hash.
 * The key prints once. Save it, because the table can't give it back.
 *
 *   TABLE_NAME=<table> npx ts-node scripts/add-client.ts acme
 */
import { createHash, randomBytes } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

async function main() {
  const clientId = process.argv[2];
  const tableName = process.env.TABLE_NAME;
  if (!clientId || !tableName) {
    console.error('Usage: TABLE_NAME=<table> npx ts-node scripts/add-client.ts <client-id>');
    process.exit(1);
  }

  const apiKey = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(apiKey).digest('hex');

  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await db.send(new PutCommand({
    TableName: tableName,
    Item: { pk: `APIKEY#${hash}`, clientId, active: true, createdAt: new Date().toISOString() },
    ConditionExpression: 'attribute_not_exists(pk)',
  }));

  console.log(`Client:  ${clientId}`);
  console.log(`API key: ${apiKey}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
