#!/usr/bin/env node
/**
 * Smoke test post-despliegue (corre contra AWS real, no hace synth).
 *
 * Verifica el wiring de la infra serverless:
 *  1. DynamoDB MedicalAppointments existe y está ACTIVE.
 *  2. Lambda cx-patient-lookup existe y responde al evento Connect
 *     con el contrato de attributes (lookupStatus found|not_found).
 *  3. Lambda cx-post-contact existe.
 *  4. Regla EventBridge cx-contact-ended está ENABLED.
 *  5. Bucket de grabaciones existe (si se informa RECORDINGS_BUCKET).
 *
 * Uso (Node >= 20, sin transpilado ni bundle: ESM nativo):
 *   npm run smoke
 *   TABLE_NAME=MedicalAppointments RECORDINGS_BUCKET=<nombre> npm run smoke
 *
 * Requiere credenciales AWS con lectura (dynamodb:DescribeTable,
 * lambda:GetFunction/InvokeFunction, events:DescribeRule, s3:ListBucket).
 * No escribe nada: la invocación de lookup es de solo lectura.
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
  // Evento sintético con el formato que envía el bloque Invoke del flow.
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
    throw new Error(`contrato roto: lookupStatus=${payload.lookupStatus}`);
  }
  ok('Lambda cx-patient-lookup', `contrato ok, lookupStatus=${payload.lookupStatus}`);
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
    console.log('SKIP  S3 recordings (informa RECORDINGS_BUCKET para verificarlo)');
    return;
  }
  await s3.send(new HeadBucketCommand({ Bucket: recordingsBucket }));
  ok('S3 recordings', recordingsBucket);
}

async function main() {
  console.log(`Smoke test demo-cx en ${region}\n`);
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
    console.error(`\n${failures} check(s) fallaron`);
    process.exit(1);
  }
  console.log('\nTodo OK');
}

await main();
