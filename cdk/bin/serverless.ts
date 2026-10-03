#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CxDataStack } from '../lib/data-stack';
import { CxComputeStack } from '../lib/compute-stack';

/**
 * Serverless CDK app (Data + Compute). No Connect dependencies:
 * synthesizes and deploys with no extra context.
 * Usage: `npm run synth:serverless`, `npm run deploy:serverless:dev`.
 */
const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const data = new CxDataStack(app, 'CxDataStack', {
  env,
  description: 'Demo-CX serverless: DynamoDB + S3 recordings.',
});

new CxComputeStack(app, 'CxComputeStack', {
  env,
  description: 'Demo-CX serverless: Lambdas + EventBridge + Bedrock.',
  table: data.table,
  recordingsBucket: data.recordingsBucket,
});

app.synth();
