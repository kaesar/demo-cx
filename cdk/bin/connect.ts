#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CxConnectStack } from '../lib/connect-stack';

/**
 * App CDK de telefonía (solo CxConnectStack). Independiente de la app
 * serverless: el vínculo flow <-> Lambda llega por contexto, no por
 * referencias entre stacks.
 * Uso: `npm run deploy:connect -- -c patientLookupArn=arn:aws:lambda:...`
 *      (+ `-c connectInstanceArn=arn:...` si ya tienes instancia).
 */
const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Instancia existente creada por consola (enfoque híbrido). Si se omite,
// el stack crea la instancia mínima `cx-medica`.
const connectInstanceArn: string | undefined = app.node.tryGetContext('connectInstanceArn');
// ARN real de cx-patient-lookup (obligatorio: Connect valida el flow).
const patientLookupArn: string | undefined = app.node.tryGetContext('patientLookupArn');

new CxConnectStack(app, 'CxConnectStack', {
  env,
  description: 'Demo-CX: Amazon Connect (voz, colas, flows). Stack independiente.',
  instanceArn: connectInstanceArn,
  patientLookupArn: patientLookupArn ?? '',
});

app.synth();
