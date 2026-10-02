import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';

export interface CxConnectStackProps extends cdk.StackProps {
  /**
   * ARN de una instancia Amazon Connect ya existente (creada por consola,
   * enfoque híbrido). Si se omite, el stack crea una instancia mínima de
   * demostración con Contact Lens activado.
   */
  readonly instanceArn?: string;
}

/**
 * Stack INDEPENDIENTE de telefonía.
 *
 * No exporta nada que el backend serverless necesite: el acoplamiento
 * flow <-> Lambda se resuelve en tiempo de configuración (ARN de la Lambda
 * pegado en el bloque Invoke del flow), no vía referencias CloudFormation
 * entre stacks. Así `CxConnectStack` se despliega (o se deja sin desplegar)
 * sin tocar `CxDataStack`/`CxComputeStack`.
 *
 * Nota: Connect en CDK solo ofrece constructs L1 (`Cfn*`). Usuarios
 * (`CfnUser` exige SecurityProfileArns) y números de teléfono (disponibilidad
 * por país) se gestionan por consola. Ver Amazon-Connect.md.
 */
export class CxConnectStack extends cdk.Stack {
  public readonly instanceArn: string;

  constructor(scope: Construct, id: string, props: CxConnectStackProps = {}) {
    super(scope, id, props);

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
    new connect.CfnContactFlow(this, 'AgendamientoFlow', {
      instanceArn,
      name: 'AgendamientoMedico',
      type: 'CONTACT_FLOW',
      content: fs.readFileSync(flowPath, 'utf8'),
    });

    new connect.CfnRoutingProfile(this, 'Routing', {
      instanceArn,
      name: 'AgentesAgendamiento',
      description: 'Voz, una llamada a la vez',
      defaultOutboundQueueArn: queue.attrQueueArn,
      mediaConcurrencies: [{ channel: 'VOICE', concurrency: 1 }],
    });

    new cdk.CfnOutput(this, 'InstanceArn', { value: instanceArn });
    new cdk.CfnOutput(this, 'QueueArn', { value: queue.attrQueueArn });
  }
}
