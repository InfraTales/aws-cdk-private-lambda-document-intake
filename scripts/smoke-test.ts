/**
 * Runs the whole flow against a deployed stack: request an upload, send a small PDF
 * straight to S3, then poll until the processor marks it VALIDATED.
 *
 *   API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com/v1/ API_KEY=<key> npx ts-node scripts/smoke-test.ts
 *
 * Calls from a browser need the Origin you set in cdk.json. This script runs from
 * Node, so CORS doesn't apply.
 */
const { API_URL, API_KEY } = process.env;

// A tiny valid PDF. The processor only checks the first bytes ("%PDF-").
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

async function call(method: string, path: string, body?: object) {
  const res = await fetch(new URL(path, API_URL), {
    method,
    headers: { 'X-Api-Key': API_KEY!, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  if (!API_URL || !API_KEY) {
    console.error('Set API_URL and API_KEY. See the comment at the top of this file.');
    process.exit(1);
  }

  const { documentId, upload } = await call('POST', 'documents', { fileName: 'smoke-test.pdf', contentType: 'application/pdf' });
  console.log(`1. Created ${documentId}`);

  const form = new FormData();
  for (const [k, v] of Object.entries<string>(upload.fields)) form.append(k, v);
  form.append('file', new Blob([PDF], { type: 'application/pdf' })); // the file must be the last field
  const s3 = await fetch(upload.url, { method: 'POST', body: form });
  if (s3.status !== 204) throw new Error(`S3 upload failed: ${s3.status} ${await s3.text()}`);
  console.log('2. Uploaded to S3');

  for (let i = 0; i < 30; i++) {
    const { status } = await call('GET', `documents/${documentId}`);
    if (status !== 'PENDING') {
      console.log(`3. Status: ${status}`);
      process.exit(status === 'VALIDATED' ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error('3. Still PENDING after 60 seconds. Check the Processor logs and the failure queue.');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
