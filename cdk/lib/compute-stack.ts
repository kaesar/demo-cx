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
   * Bedrock model for summaries. Nova Micro/Lite in us-east-1 by default.
   * Overridable via `bedrockModelId` context.
   */
  readonly bedrockModelId?: string;
}

/**
 * Serverless COMPUTE stack. No VPC by design: no Lambda needs access to
 * private resources (DynamoDB, S3, Bedrock and EventBridge are invoked
 * over public endpoints with IAM). If an advanced phase ever required a VPC
 * (e.g. integration with a private hospital HIS), a CxNetworkStack would be
 * added and these functions would move to `vpc` + interface endpoints for
 * DynamoDB/S3/Bedrock. That change is additive and never touches Connect.
 */
export class CxComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CxComputeStackProps) {
    super(scope, id, props);

    const bedrockModelId =
      props.bedrockModelId ??
      (this.node.tryGetContext('bedrockModelId') as string | undefined) ??
      'amazon.nova-micro-v1:0';

    // --- Lambda invoked from the Contact Flow ---
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
    // Lets Amazon Connect invoke the function from a flow's
    // "Invoke AWS Lambda function" block.
    lookup.addPermission('AllowConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    // --- Post-contact Lambda ---
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

    // EventBridge: Connect end-of-contact events -> post-contact.
    // A concrete InstanceId is filtered via `connectInstanceId` context;
    // without it, the rule listens to every instance in the account/region.
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
