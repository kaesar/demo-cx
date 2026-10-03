import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { CxConnectStack } from '../lib/connect-stack';
import { CxDataStack } from '../lib/data-stack';
import { CxComputeStack } from '../lib/compute-stack';

describe('Demo-CX stacks synthesize with no VPC and no cross-coupling', () => {
  const LOOKUP_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:cx-patient-lookup';

  test('ConnectStack creates queue, hours, flow and routing (no external instance)', () => {
    const app = new cdk.App();
    const stack = new CxConnectStack(app, 'TConnect', { patientLookupArn: LOOKUP_ARN });
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::Connect::HoursOfOperation', 1);
    t.resourceCountIs('AWS::Connect::Queue', 1);
    t.resourceCountIs('AWS::Connect::ContactFlow', 1);
    t.resourceCountIs('AWS::Connect::RoutingProfile', 1);
    // By default it creates the demo instance (hybrid: skipped with external ARN).
    t.resourceCountIs('AWS::Connect::Instance', 1);
    // The flow carries the substituted real ARN (no pending tokens).
    const templateJson = JSON.stringify(t.toJSON());
    expect(templateJson).toContain(LOOKUP_ARN);
    expect(templateJson).not.toContain('__PATIENT_LOOKUP_ARN__');
    expect(templateJson).not.toContain('__QUEUE_ARN__');
  });

  test('ConnectStack with existing ARN creates no instance', () => {
    const app = new cdk.App();
    const stack = new CxConnectStack(app, 'TConnectImport', {
      instanceArn: 'arn:aws:connect:us-east-1:123456789012:instance/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      patientLookupArn: LOOKUP_ARN,
    });
    Template.fromStack(stack).resourceCountIs('AWS::Connect::Instance', 0);
  });

  test('ConnectStack without lookup ARN fails synth with a clear message', () => {
    const app = new cdk.App();
    expect(() => new CxConnectStack(app, 'TConnectFail', { patientLookupArn: '' })).toThrow(
      /patientLookupArn/,
    );
  });

  test('Serverless: single-table + bucket + 2 lambdas + EventBridge rule', () => {
    const app = new cdk.App();
    const data = new CxDataStack(app, 'TData');
    const compute = new CxComputeStack(app, 'TCompute', {
      table: data.table,
      recordingsBucket: data.recordingsBucket,
    });
    Template.fromStack(data).resourceCountIs('AWS::DynamoDB::Table', 1);
    Template.fromStack(data).resourceCountIs('AWS::S3::Bucket', 1);
    const tc = Template.fromStack(compute);
    // Our 2 functions (a 3rd one is CDK's logRetention custom resource).
    tc.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'cx-patient-lookup' });
    tc.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'cx-post-contact' });
    tc.resourceCountIs('AWS::Events::Rule', 1);
    // No VPC: no function declares VpcConfig.
    const lambdas = tc.findResources('AWS::Lambda::Function');
    Object.values(lambdas).forEach((fn: any) => {
      expect(fn.Properties?.VpcConfig).toBeUndefined();
    });
  });
});
