# Security

## Controls

| Control | Where | Why |
|---|---|---|
| Isolated subnets, no NAT, no internet gateway | `Vpc` | Code that reads identity documents has no route out to the internet |
| Gateway endpoint policies | `S3Endpoint`, `DynamoDbEndpoint` | From inside the VPC, nobody can reach any bucket or table except this stack's |
| SHA-256 hashed API keys | `lambda/authorizer.ts`, `scripts/add-client.ts` | A table export or backup contains no working key |
| Same 404 for "missing" and "not yours" | `lambda/api.ts` | One client can't learn which document IDs exist |
| Presigned POST with signed conditions | `lambda/api.ts` | S3 itself refuses files over 10 MB, the wrong content type, or a different key |
| File type from the first 8 bytes | `lambda/processor.ts` | The client controls the file name and Content-Type, but the first bytes show the real format |
| SSE-KMS with key rotation and a Bucket Key | `Documents` bucket | Encryption under your own key, with fewer KMS calls |
| TLS-only bucket policies | both buckets | Requests over plain HTTP get denied |
| Request validation (JSON schema) | `DocumentApi` | Only `fileName` and one of three content types reach the function |
| Stage throttling and WAF rate rule | `DocumentApi`, `ApiWaf` | Caps abuse without relying on usage plans |
| One named CORS origin | API and bucket | Browsers on other sites can't call the API or post files |
| Retained bucket, table and key; table deletion protection | storage | A mistaken `cdk destroy` doesn't delete customer data |
| S3 server access logs, VPC flow logs (rejected traffic) | storage, network | An audit trail for uploads and blocked connections |

## AWS Security Hub checks this stack is built to pass

- EC2.2: the VPC default security group allows no traffic
- S3.5: buckets require TLS (`aws:SecureTransport`)
- S3.17: the documents bucket uses an AWS KMS key for encryption at rest
- DynamoDB.2: point-in-time recovery is on
- Lambda.2: functions run on a supported runtime (Node.js 24)

## What it doesn't do

- Scan files for malware. Turn on Amazon GuardDuty Malware Protection for S3 for that.
- Authenticate end users. The API is machine to machine. If browsers call it on behalf of signed-in users, put Amazon Cognito or your own identity provider in front.
- Rotate API keys. Issue a new key with `scripts/add-client.ts`, then set `active` to `false` on the old item.
