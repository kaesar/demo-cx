#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CxConnectStack } from '../lib/connect-stack';
import { CxDataStack } from '../lib/data-stack';
import { CxComputeStack } from '../lib/compute-stack';

/**
 * Demo-CX — Agendamiento de citas médicas.
 *
 * Separación deliberada (pedida por el dueño del repo):
 *  - CxConnectStack  -> infraestructura Amazon Connect (voz, colas, flows).
 *                      Despliegue independiente: `npm run deploy:connect`
 *  - CxDataStack + CxComputeStack -> todo lo serverless (DynamoDB, S3,
 *                      Lambdas, EventBridge, Bedrock). Sin VPC: las Lambdas
 *                      corren fuera de VPC y usan endpoints públicos de AWS.
 *                      Despliegue independiente: `npm run deploy:serverless:dev`
 *
 * Los stacks serverless NO importan recursos del stack Connect (acoplamiento
 * solo vía ARNs por contexto/SSM en fases avanzadas). De este modo se puede
 * iterar el backend sin tocar la telefonía.
 *
 * Fase futura opcional: si alguna Lambda necesitara acceso a recursos privados
 * (p. ej. base de datos en VPC), se añadirá un CxNetworkStack (VPC) y solo el
 * ComputeStack pasará a correr dentro de la VPC. Hoy NO es necesario.
 */
const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Instancia existente creada por consola (enfoque híbrido). Si se informa
// `connectInstanceArn` por contexto (-c connectInstanceArn=arn:...), el
// ConnectStack importa horas/colas/flows sobre ella; si no, crea una
// instancia mínima de demostración (ver lib/connect-stack.ts).
const connectInstanceArn: string | undefined = app.node.tryGetContext('connectInstanceArn');

new CxConnectStack(app, 'CxConnectStack', {
  env,
  description: 'Demo-CX: Amazon Connect (voz, colas, flows). Stack independiente.',
  instanceArn: connectInstanceArn,
});

// --- Serverless (independiente de Connect) ---
const data = new CxDataStack(app, 'CxDataStack', {
  env,
  description: 'Demo-CX serverless: DynamoDB + S3 grabaciones.',
});

new CxComputeStack(app, 'CxComputeStack', {
  env,
  description: 'Demo-CX serverless: Lambdas + EventBridge + Bedrock.',
  table: data.table,
  recordingsBucket: data.recordingsBucket,
});

app.synth();
