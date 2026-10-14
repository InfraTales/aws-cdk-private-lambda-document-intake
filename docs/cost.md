# Cost

Prices are on-demand in us-east-1, taken from the AWS Price List API on 2026-10-14. Check them again before you rely on them.

## A month at 10,000 documents

Assumptions: files of about 1 MB, three API calls per document (one POST, two status checks), and an authorizer cache hit for most calls.

| Item | Math | Monthly |
|---|---|---|
| AWS WAF | $5 web ACL + $1 for the managed rule group + $1 for the rate rule + 30,000 requests × $0.60/M | $7.02 |
| AWS KMS | $1 per key. S3 Bucket Keys keep the request count inside the 20,000 free requests | $1.00 |
| Amazon S3 | 10 GB × $0.023 + 10,000 POSTs × $0.005/1,000 + 10,000 ranged GETs × $0.0004/1,000 | $0.29 |
| Amazon CloudWatch | 2 alarms × $0.10, plus log ingestion at $0.50/GB | about $0.25 |
| Amazon API Gateway (REST) | 30,000 requests × $3.50/M | $0.11 |
| AWS Lambda (Arm) | about 2,400 GB-seconds and 50,000 requests; the free tier covers it | $0.00 to $0.04 |
| Amazon DynamoDB (on-demand) | about 20,000 writes × $0.625/M plus reads; PITR on a small table | about $0.02 |
| VPC gateway endpoints | no charge | $0.00 |
| **Total** | | **about $8.70** |

S3 storage grows each month you keep files. After 30 days the lifecycle rule moves them to Standard-IA at $0.0125/GB-month.

## What the design avoids

| Item | Monthly cost it would add |
|---|---|
| Two NAT gateways (one per AZ) | about $73.00 ($0.045/hr each, plus $0.005/hr for each public IPv4 address), plus $0.045 per GB processed |
| One interface endpoint in two AZs | $14.60, plus $0.01 per GB |

## Optional

Amazon GuardDuty Malware Protection for S3 costs $0.09 per GB scanned plus $0.000215 per object, after a free tier of 1 GB and 1,000 objects a month. At the volume above that adds about $2.75.

## Sources

- AWS Price List API offer files for AmazonEC2, AmazonVPC, awskms, AWSLambda, AmazonDynamoDB, AmazonApiGateway, AmazonCloudWatch, awswaf, AmazonS3 and AmazonGuardDuty (us-east-1)
- https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html
- https://aws.amazon.com/privatelink/pricing/
