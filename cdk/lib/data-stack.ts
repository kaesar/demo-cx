import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Serverless DATA stack. No VPC (DynamoDB and S3 are managed services
 * with public endpoints; access is controlled with least-privilege IAM).
 */
export class CxDataStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly recordingsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Single-table model (PLAN.md §5):
    //   PK = PATIENT#<documentId>
    //   SK = PROFILE | APPOINTMENT#<date>#<id> | INTERACTION#<contactId>
    this.table = new dynamodb.Table(this, 'MedicalAppointments', {
      tableName: 'MedicalAppointments',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Lookup by appointment status for operational listings (GSI1: estado -> cita).
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1-estado',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['fecha', 'hora', 'especialidad', 'medico', 'estado'],
    });

    this.recordingsBucket = new s3.Bucket(this, 'Recordings', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ enabled: true, expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
    new cdk.CfnOutput(this, 'RecordingsBucket', { value: this.recordingsBucket.bucketName });
  }
}
