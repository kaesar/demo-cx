import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { CxConnectStack } from '../lib/connect-stack';
import { CxDataStack } from '../lib/data-stack';
import { CxComputeStack } from '../lib/compute-stack';

describe('Demo-CX stacks sintetizan sin VPC y sin acoplamientos cruzados', () => {
  const LOOKUP_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:cx-patient-lookup';

  test('ConnectStack crea cola, horario, flow y routing (sin instancia externa)', () => {
    const app = new cdk.App();
    const stack = new CxConnectStack(app, 'TConnect', { patientLookupArn: LOOKUP_ARN });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::Connect::HoursOfOperation', 1);
    t.resourceCountIs('AWS::Connect::Queue', 1);
    t.resourceCountIs('AWS::Connect::ContactFlow', 1);
    t.resourceCountIs('AWS::Connect::RoutingProfile', 1);
    // Por defecto crea la instancia demo (híbrido: con ARN externo no la crea).
    t.resourceCountIs('AWS::Connect::Instance', 1);
    // El flow lleva el ARN real sustituido (sin tokens pendientes).
    const templateJson = JSON.stringify(t.toJSON());
    expect(templateJson).toContain(LOOKUP_ARN);
    expect(templateJson).not.toContain('__PATIENT_LOOKUP_ARN__');
    expect(templateJson).not.toContain('__QUEUE_ARN__');
  });

  test('ConnectStack con ARN existente no crea instancia', () => {
    const app = new cdk.App();
    const stack = new CxConnectStack(app, 'TConnectImport', {
      instanceArn: 'arn:aws:connect:us-east-1:123456789012:instance/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      patientLookupArn: LOOKUP_ARN,
    });
    Template.fromStack(stack).resourceCountIs('AWS::Connect::Instance', 0);
  });

  test('ConnectStack sin lookup ARN falla en synth con mensaje claro', () => {
    const app = new cdk.App();
    expect(() => new CxConnectStack(app, 'TConnectFail', { patientLookupArn: '' })).toThrow(
      /patientLookupArn/,
    );
  });

  test('Serverless: tabla single-table + bucket + 2 lambdas + regla EventBridge', () => {
    const app = new cdk.App();
    const data = new CxDataStack(app, 'TData');
    const compute = new CxComputeStack(app, 'TCompute', {
      table: data.table,
      recordingsBucket: data.recordingsBucket,
    });
    Template.fromStack(data).resourceCountIs('AWS::DynamoDB::Table', 1);
    Template.fromStack(data).resourceCountIs('AWS::S3::Bucket', 1);
    const tc = Template.fromStack(compute);
    // Las 2 funciones propias (una 3ª es el custom resource de logRetention de CDK).
    tc.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'cx-patient-lookup' });
    tc.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'cx-post-contact' });
    tc.resourceCountIs('AWS::Events::Rule', 1);
    // Sin VPC: ninguna función declara VpcConfig.
    const lambdas = tc.findResources('AWS::Lambda::Function');
    Object.values(lambdas).forEach((fn: any) => {
      expect(fn.Properties?.VpcConfig).toBeUndefined();
    });
  });
});
