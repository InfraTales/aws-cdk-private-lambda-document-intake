# Runbook

## The "FailedDocumentsAlarm" fired

A document failed processing three times (the first try plus two retries) and its S3 event landed in the `ProcessingFailures` queue.

1. Open the queue in the SQS console and read a message. Lambda wraps the original S3 event in `requestPayload` and puts the error from the last attempt in `responsePayload`.
2. Open the `Processor` log group in CloudWatch Logs and search for the document ID (the last part of the key).
3. Common causes:
   - **AccessDenied from S3 or KMS.** Someone changed the role, the key policy or the endpoint policy. Compare with the stack in git.
   - **Throttling from DynamoDB.** Unlikely on on-demand tables, but possible after a large burst. The record is still `PENDING`, so a retry is safe.
   - **Timeout.** The processor has 60 seconds and reads 8 bytes. A timeout points at networking: check that the S3 gateway endpoint is still attached to the subnets' route tables.
4. After you fix the cause, replay the event: invoke the `Processor` function with the `requestPayload` object from the message as the payload. The function only moves `PENDING` records forward, so replaying a record that already finished does nothing.
5. Delete the message from the queue.

## A client says uploads fail with 403

- The presigned form expires after 5 minutes, so the client has to upload soon after calling `POST /documents`.
- The `Content-Type` field in the upload must match what the client sent to `POST /documents`.
- A browser upload from a different origin than `allowedOrigin` fails on CORS before it reaches S3.

## A client says uploads fail with 400

The file is over 10 MB, or empty. Change `MAX_BYTES` in the stack if you need a different limit.

## Records stuck in PENDING

A record stays `PENDING` when the client never uploaded. DynamoDB deletes it through TTL about 24 hours after creation. If the file is in S3 but the record is still `PENDING`, check the alarm steps above.
