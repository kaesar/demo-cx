#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CxConnectStack } from '../lib/connect-stack';

/**
 * Telephony CDK app (CxConnectStack only). Independent from the serverless
 * app: the flow <-> Lambda link arrives via context, not via cross-stack
 * references.
 * Usage: `npm run deploy:connect -- -c patientLookupArn=arn:aws:lambda:...`
 *      (+ `-c connectInstanceArn=arn:...` if you already own an instance).
 */
const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Existing console-created instance (hybrid approach). If omitted,
// the stack creates the minimal `cx-medica` instance.
const connectInstanceArn: string | undefined = app.node.tryGetContext('connectInstanceArn');
// Real ARN of cx-patient-lookup (required: Connect validates the flow).
const patientLookupArn: string | undefined = app.node.tryGetContext('patientLookupArn');

new CxConnectStack(app, 'CxConnectStack', {
  env,
  description: 'Demo-CX: Amazon Connect (voice, queues, flows). Independent stack.',
  instanceArn: connectInstanceArn,
  patientLookupArn: patientLookupArn ?? '',
});

app.synth();
