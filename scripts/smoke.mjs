#!/usr/bin/env node
/**
 * Post-deploy smoke test (runs against real AWS, no synth).
 *
 * Verifies the serverless infra wiring:
 *  1. DynamoDB MedicalAppointments exists and is ACTIVE.
 *  2. cx-patient-lookup Lambda exists and answers the Connect event
 *     with the attributes contract (lookupStatus found|not_found).
 *  3. cx-post-contact Lambda exists.
 *  4. cx-contact-ended EventBridge rule is ENABLED.
 *  5. Recordings bucket exists (when RECORDINGS_BUCKET is provided).
 *
 * Usage (Node >= 22, no transpile or bundle: native ESM):
 *   npm run smoke
 *   TABLE_NAME=MedicalAppointments RECORDINGS_BUCKET=<name> npm run smoke
 *
 * Requires read AWS credentials (dynamodb:DescribeTable,
 * lambda:GetFunction/InvokeFunction, events:DescribeRule, s3:ListBucket).
 * Writes nothing: the lookup invocation is read-only.
 */
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { LambdaClient, GetFunctionCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { EventBridgeClient, DescribeRuleCommand } from '@aws-sdk/client-eventbridge';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';

const region = process.env.AWS_REGION ?? 'us-east-1';
const tableName = process.env.TABLE_NAME ?? 'MedicalAppointments';
const recordingsBucket = process.env.RECORDINGS_BUCKET ?? '';

const ddb = new DynamoDBClient({ region });
const lambda = new LambdaClient({ region });
const events = new EventBridgeClient({ region });
const s3 = new S3Client({ region });

let failures = 0;
const ok = (name, detail = '') => console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`);
const fail = (name, err) => {
  failures += 1;
  console.error(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
};

async function checkTable() {
  const out = await ddb.send(new DescribeTableCommand({ TableName: tableName }));
  if (out.Table?.TableStatus !== 'ACTIVE') throw new Error(`TableStatus=${out.Table?.TableStatus}`);
  ok('DynamoDB table', `${tableName} ACTIVE, ${out.Table?.ItemCount ?? '?'} items`);
}

async function checkLookup() {
  await lambda.send(new GetFunctionCommand({ FunctionName: 'cx-patient-lookup' }));
  // Synthetic event in the shape sent by the flow's Invoke block.
  const event = {
    Details: {
      ContactData: { ContactId: 'smoke-test', Attributes: {} },
      Parameters: { documentId: '00000000' },
    },
  };
  const res = await lambda.send(
    new InvokeCommand({ FunctionName: 'cx-patient-lookup', Payload: Buffer.from(JSON.stringify(event)) }),
  );
  if (res.StatusCode !== 200 || res.FunctionError) {
    throw new Error(`invoke StatusCode=${res.StatusCode} FunctionError=${res.FunctionError ?? 'none'}`);
  }
  const payload = JSON.parse(Buffer.from(res.Payload ?? []).toString());
  if (!['found', 'not_found'].includes(payload.lookupStatus ?? '')) {
    throw new Error(`broken contract: lookupStatus=${payload.lookupStatus}`);
  }
  ok('Lambda cx-patient-lookup', `contract ok, lookupStatus=${payload.lookupStatus}`);
}

async function checkPostContact() {
  const fn = await lambda.send(new GetFunctionCommand({ FunctionName: 'cx-post-contact' }));
  if (fn.Configuration?.State !== 'Active') throw new Error(`State=${fn.Configuration?.State}`);
  ok('Lambda cx-post-contact', `Active, runtime=${fn.Configuration?.Runtime}`);
}

async function checkRule() {
  const rule = await events.send(new DescribeRuleCommand({ Name: 'cx-contact-ended' }));
  if (rule.State !== 'ENABLED') throw new Error(`State=${rule.State}`);
  ok('EventBridge cx-contact-ended', 'ENABLED');
}

async function checkBucket() {
  if (!recordingsBucket) {
    console.log('SKIP  S3 recordings (set RECORDINGS_BUCKET to verify it)');
    return;
  }
  await s3.send(new HeadBucketCommand({ Bucket: recordingsBucket }));
  ok('S3 recordings', recordingsBucket);
}

async function main() {
  console.log(`Smoke test demo-cx in ${region}\n`);
  for (const [name, fn] of [
    ['table', checkTable],
    ['lookup', checkLookup],
    ['post-contact', checkPostContact],
    ['rule', checkRule],
    ['bucket', checkBucket],
  ]) {
    try {
      await fn();
    } catch (err) {
      fail(name, err);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll OK');
}

await main();
