import type { Handler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

/**
 * `patient-lookup` Lambda.
 *
 * Invoked from the Contact Flow's "Invoke AWS Lambda function" block.
 * Input (Connect event): Details.ContactData.Attributes + Details.Parameters
 * with `documentId` (DTMF) or `phone` (ANI). Output: flat string->string map
 * that Connect merges as Contact Attributes:
 *   patientName, patientType (nuevo|recurrente|prioritario), lookupStatus
 *   (found|not_found), nextAppointment (ISO or ""), appointmentsCount.
 *
 * DynamoDB contract (single-table, see DataStack):
 *   Get  pk=PATIENT#<doc> sk=PROFILE
 *   Query pk=PATIENT#<doc> sk begins_with APPOINTMENT# (filter estado=programada)
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

  // Canonical identifier: document when provided via DTMF, phone otherwise.
  // (Future enhancement: secondary index by phone via GSI; for now the PK
  // is derived as PATIENT#<phone> so the flow is never blocked.)
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
