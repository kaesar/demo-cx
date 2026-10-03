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
  /**
   * ARN de la Lambda `cx-patient-lookup` (stack serverless, ya desplegado).
   * Obligatorio: Connect valida el flow al crearlo y rechaza ARNs de
   * ejemplo o inexistentes (InvalidContactFlowException). Se pasa por
   * contexto: `-c patientLookupArn=arn:aws:lambda:...`.
   */
  readonly patientLookupArn: string;
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

  constructor(scope: Construct, id: string, props: CxConnectStackProps) {
    super(scope, id, props);

    if (!props.patientLookupArn || props.patientLookupArn.includes('__')) {
      throw new Error(
        'CxConnectStack requiere patientLookupArn (ARN real de cx-patient-lookup). ' +
          'Despliega serverless primero y pasa -c patientLookupArn=arn:aws:lambda:...',
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
    // El JSON versionado trae tokens que se resuelven aquí con recursos
    // reales (la API de Connect valida el contenido al crear el flow).
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
      description: 'Voz, una llamada a la vez',
      defaultOutboundQueueArn: queue.attrQueueArn,
      mediaConcurrencies: [{ channel: 'VOICE', concurrency: 1 }],
    });

    new cdk.CfnOutput(this, 'InstanceArn', { value: instanceArn });
    new cdk.CfnOutput(this, 'QueueArn', { value: queue.attrQueueArn });
  }
}
