import type { Handler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Lambda `patient-lookup` (Fase 2).
 *
 * Invocada desde el bloque "Invoke AWS Lambda function" del Contact Flow.
 * Entrada (evento Connect): Details.ContactData.Attributes + Details.Parameters
 * con `documentId` (DTMF) o `phone` (ANI). Salida: mapa plano string->string
 * que Connect fusiona como Contact Attributes:
 *   patientName, patientType (nuevo|recurrente|prioritario), lookupStatus
 *   (found|not_found), nextAppointment (ISO o ""), appointmentsCount.
 *
 * Contrato DynamoDB (single-table, ver DataStack):
 *   Get  pk=PATIENT#<doc> sk=PROFILE
 *   Query pk=PATIENT#<doc> sk begins_with APPOINTMENT# (filtro estado=programada)
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

interface ConnectLambdaEvent {
  Details?: {
    ContactData?: { ContactId?: string; Attributes?: Record<string, string> };
    Parameters?: Record<string, string>;
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const handler: Handler<ConnectLambdaEvent, Record<string, string>> = async (event) => {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME env var is required');

  const params = event.Details?.Parameters ?? {};
  const attrs = event.Details?.ContactData?.Attributes ?? {};
  const contactId = event.Details?.ContactData?.ContactId ?? 'unknown';
  const documentId = str(params.documentId ?? params.documento ?? attrs.documentId).trim();
  const phone = str(params.phone ?? params.telefono ?? attrs.phone).trim();

  console.info(JSON.stringify({ msg: 'patient-lookup start', contactId, hasDoc: !!documentId, hasPhone: !!phone }));

  const fail = (reason: string): Record<string, string> => {
    console.warn(JSON.stringify({ msg: 'patient-lookup miss', contactId, reason }));
    return { lookupStatus: 'not_found', patientName: '', patientType: 'nuevo', nextAppointment: '', appointmentsCount: '0' };
  };

  // Identificador canónico: documento si viene por DTMF; si no, teléfono.
  // (Fase avanzada: índice secundario por teléfono vía GSI; hoy se deriva
  // la PK como PATIENT#<phone> para no bloquear el flujo.)
  const key = documentId || phone.replace(/\D/g, '');
  if (!key) return fail('missing_identifier');

  const pk = `PATIENT#${key}`;
  const profile = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk, sk: 'PROFILE' } }));
  const item = (profile.Item ?? null) as null | {
    nombre?: string;
    tipo?: string;
    telefono?: string;
  };
  if (!item) return fail('profile_not_found');

  const appts = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: '#estado = :prog',
      ExpressionAttributeNames: { '#estado': 'estado' },
      ExpressionAttributeValues: { ':pk': pk, ':prefix': 'APPOINTMENT#', ':prog': 'programada' },
      Limit: 10,
    }),
  );
  const upcoming = ((appts.Items ?? []) as Array<{ fecha?: string; hora?: string }>)
    .map((a) => `${a.fecha ?? ''}T${a.hora ?? ''}`)
    .filter((s) => s.length > 1)
    .sort();
  const patientType = ['nuevo', 'recurrente', 'prioritario'].includes(item.tipo ?? '')
    ? (item.tipo as string)
    : 'recurrente';

  const result = {
    lookupStatus: 'found',
    patientName: item.nombre ?? '',
    patientType,
    nextAppointment: upcoming[0] ?? '',
    appointmentsCount: String(appts.Count ?? upcoming.length),
  };
  console.info(JSON.stringify({ msg: 'patient-lookup ok', contactId, ...result }));
  return result;
};
