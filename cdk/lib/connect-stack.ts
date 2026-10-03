import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';

export interface CxConnectStackProps extends cdk.StackProps {
  /**
   * ARN of an existing Amazon Connect instance (created via console,
   * hybrid approach). If omitted, the stack creates a minimal demo
   * instance with Contact Lens enabled.
   */
  readonly instanceArn?: string;
  /**
   * ARN of the `cx-patient-lookup` Lambda (serverless stack, already deployed).
   * Required: Connect validates the flow on creation and rejects sample
   * or nonexistent ARNs (InvalidContactFlowException). Passed via
   * context: `-c patientLookupArn=arn:aws:lambda:...`.
   */
  readonly patientLookupArn: string;
}

/**
 * INDEPENDENT telephony stack.
 *
 * It exports nothing the serverless backend needs: the flow <-> Lambda
 * coupling is resolved at configuration time (Lambda ARN pasted into the
 * flow's Invoke block), not via CloudFormation references between stacks.
 * This way `CxConnectStack` deploys (or stays undeployed) without
 * touching `CxDataStack`/`CxComputeStack`.
 *
 * Note: Connect on CDK only offers L1 constructs (`Cfn*`). Users
 * (`CfnUser` requires SecurityProfileArns) and phone numbers (availability
 * varies by country) are managed via console. See Amazon-Connect.md.
 */
export class CxConnectStack extends cdk.Stack {
  public readonly instanceArn: string;

  constructor(scope: Construct, id: string, props: CxConnectStackProps) {
    super(scope, id, props);

    if (!props.patientLookupArn || props.patientLookupArn.includes('__')) {
      throw new Error(
        'CxConnectStack requires patientLookupArn (real ARN of cx-patient-lookup). ' +
          'Deploy serverless first and pass -c patientLookupArn=arn:aws:lambda:...',
      );
    }

    let instanceArn = props.instanceArn;
    if (!instanceArn) {
      const instance = new connect.CfnInstance(this, 'Instance', {
        identityManagementType: 'CONNECT_MANAGED',
        instanceAlias: 'cx-medica',
        attributes: { inboundCalls: true, outboundCalls: true, contactLens: true },
      });
      instanceArn = instance.attrArn;
    }
    this.instanceArn = instanceArn;

    const hours = new connect.CfnHoursOfOperation(this, 'Hours', {
      instanceArn,
      name: 'HorarioLaboral',
      timeZone: 'America/Bogota',
      config: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map((day) => ({
        day,
        startTime: { hours: 8, minutes: 0 },
        endTime: { hours: 18, minutes: 0 },
      })),
    });

    const queue = new connect.CfnQueue(this, 'Queue', {
      instanceArn,
      name: 'AgendamientoMedico',
      hoursOfOperationArn: hours.attrHoursOfOperationArn,
    });

    const flowPath = path.join(__dirname, '..', 'contact-flows', 'agendamiento-v1.json');
    // The versioned JSON carries tokens resolved here with real
    // resources (the Connect API validates content on flow creation).
    const flowContent = fs
      .readFileSync(flowPath, 'utf8')
      .replace(/__PATIENT_LOOKUP_ARN__/g, props.patientLookupArn)
      .replace(/__QUEUE_ARN__/g, queue.attrQueueArn);
    new connect.CfnContactFlow(this, 'AgendamientoFlow', {
      instanceArn,
      name: 'AgendamientoMedico',
      type: 'CONTACT_FLOW',
      content: flowContent,
    });

    new connect.CfnRoutingProfile(this, 'Routing', {
      instanceArn,
      name: 'AgentesAgendamiento',
      description: 'Voice, one call at a time',
      defaultOutboundQueueArn: queue.attrQueueArn,
      mediaConcurrencies: [{ channel: 'VOICE', concurrency: 1 }],
    });

    new cdk.CfnOutput(this, 'InstanceArn', { value: instanceArn });
    new cdk.CfnOutput(this, 'QueueArn', { value: queue.attrQueueArn });
  }
}
