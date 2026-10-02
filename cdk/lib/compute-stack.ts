import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export interface CxComputeStackProps extends cdk.StackProps {
  readonly table: dynamodb.Table;
  readonly recordingsBucket: s3.Bucket;
  /**
   * Modelo Bedrock para resúmenes (Fase 6). Por defecto Nova Micro/Lite
   * en us-east-1. Se puede sobreescribir por contexto `bedrockModelId`.
   */
  readonly bedrockModelId?: string;
}

/**
 * Stack serverless de CÓMPUTO. Sin VPC por diseño: ninguna Lambda necesita
 * acceso a recursos privados (DynamoDB, S3, Bedrock y EventBridge se invocan
 * por endpoints públicos con IAM). Si en una fase avanzada hiciera falta VPC
 * (p. ej. integración con un HIS hospitalario privado), se añadirá un
 * CxNetworkStack y estas funciones pasarán a `vpc` + endpoints de interfaz
 * para DynamoDB/S3/Bedrock. Ese cambio es aditivo y no toca Connect.
 */
export class CxComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CxComputeStackProps) {
    super(scope, id, props);

    const bedrockModelId =
      props.bedrockModelId ??
      (this.node.tryGetContext('bedrockModelId') as string | undefined) ??
      'amazon.nova-micro-v1:0';

    // --- Lambda invocada desde el Contact Flow (Fase 2) ---
    const lookupLogs = new logs.LogGroup(this, 'PatientLookupLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const lookup = new NodejsFunction(this, 'PatientLookup', {
      functionName: 'cx-patient-lookup',
      entry: path.join(__dirname, '..', '..', 'srv', 'patient-lookup', 'index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      logGroup: lookupLogs,
      environment: { TABLE_NAME: props.table.tableName },
    });
    props.table.grantReadData(lookup);
    // Permite que Amazon Connect invoque la función desde un bloque
    // "Invoke AWS Lambda function" del flow.
    lookup.addPermission('AllowConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    // --- Lambda post-contacto (Fases 3 y 6) ---
    const postContactLogs = new logs.LogGroup(this, 'PostContactLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const postContact = new NodejsFunction(this, 'PostContact', {
      functionName: 'cx-post-contact',
      entry: path.join(__dirname, '..', '..', 'srv', 'post-contact', 'index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      logGroup: postContactLogs,
      environment: {
        TABLE_NAME: props.table.tableName,
        RECORDINGS_BUCKET: props.recordingsBucket.bucketName,
        BEDROCK_MODEL_ID: bedrockModelId,
        AWS_REGION_NAME: this.region,
      },
    });
    props.table.grantReadWriteData(postContact);
    props.recordingsBucket.grantRead(postContact);
    postContact.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
        conditions: {
          StringLike: { 'bedrock:ModelId': ['amazon.nova-*', 'anthropic.*'] },
        },
      }),
    );

    // EventBridge: eventos de fin de contacto de Connect -> post-contacto.
    // El InstanceId concreto se filtra por contexto `connectInstanceId`;
    // sin él, la regla escucha todas las instancias de la cuenta/región.
    const connectInstanceId = this.node.tryGetContext('connectInstanceId') as string | undefined;
    new events.Rule(this, 'ContactEndedRule', {
      ruleName: 'cx-contact-ended',
      eventPattern: {
        source: ['aws.connect'],
        detailType: ['Amazon Connect Contact Event'],
        detail: {
          eventType: ['DISCONNECTED', 'ENDED'],
          ...(connectInstanceId ? { instanceId: [connectInstanceId] } : {}),
        },
      },
      targets: [new targets.LambdaFunction(postContact)],
    });

    new cdk.CfnOutput(this, 'PatientLookupArn', { value: lookup.functionArn });
    new cdk.CfnOutput(this, 'PostContactArn', { value: postContact.functionArn });
    new cdk.CfnOutput(this, 'BedrockModelId', { value: bedrockModelId });
  }
}
