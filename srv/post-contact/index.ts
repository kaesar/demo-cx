import type { Handler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * `post-contact` Lambda.
 *
 * Trigger: EventBridge rule on `Amazon Connect Contact Event`
 * (DISCONNECTED/ENDED). Persists the outcome to the single-table as
 *   pk=PATIENT#<doc|unknown> sk=INTERACTION#<contactId>
 * and, when a transcript is available in the event, calls Bedrock (Nova
 * Micro/Lite by default) to generate the structured summary
 * {motivo, acciones, sentimiento, proximosPasos, alertas}.
 *
 * Defensive design: if Bedrock fails or there is no transcript, the
 * interaction is still stored with `summaryStatus: skipped|error` and can
 * be reprocessed manually later. The call record is never lost.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const bedrock = new BedrockRuntimeClient({});

interface ContactEvent {
  version?: string;
  source?: string;
  detail?: {
    contactId?: string;
    instanceId?: string;
    eventType?: string;
    connectedToSystemTimestamp?: string;
    disconnectTimestamp?: string;
    contactData?: { attributes?: Record<string, string>; customerEndpoint?: { address?: string } };
    transcript?: string;
  };
}

interface Summary {
  motivo: string;
  acciones: string[];
  sentimiento: string;
  proximosPasos: string[];
  alertas: string[];
}

async function summarizeWithBedrock(transcript: string, context: Record<string, string>): Promise<Summary | null> {
  const modelId = process.env.BEDROCK_MODEL_ID ?? 'amazon.nova-micro-v1:0';
  const prompt = [
    'Eres un asistente de una clínica médica. Resume la siguiente interacción telefónica de agendamiento de citas.',
    'Devuelve SOLO un JSON válido con las claves: motivo (string), acciones (string[]),',
    'sentimiento (string: positivo|neutral|negativo), proximosPasos (string[]), alertas (string[]).',
    `Contexto: ${JSON.stringify(context)}`,
    `Transcript:\n${transcript.slice(0, 6000)}`,
  ].join('\n');

  const body = JSON.stringify({
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 800, temperature: 0.2 },
  });

  try {
    const res = await bedrock.send(
      new InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body }),
    );
    const payload = JSON.parse(new TextDecoder().decode(res.body)) as {
      output?: { message?: { content?: Array<{ text?: string }> } };
    };
    const text = payload.output?.message?.content?.[0]?.text ?? '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(text.slice(start, end + 1)) as Summary;
    if (!parsed.motivo) return null;
    return {
      motivo: String(parsed.motivo),
      acciones: (parsed.acciones ?? []).map(String),
      sentimiento: String(parsed.sentimiento ?? 'neutral'),
      proximosPasos: (parsed.proximosPasos ?? []).map(String),
      alertas: (parsed.alertas ?? []).map(String),
    };
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'bedrock summary failed', err: String(err) }));
    return null;
  }
}

export const handler: Handler<ContactEvent, { ok: boolean; summaryStatus: string }> = async (event) => {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME env var is required');

  const detail = event.detail ?? {};
  const contactId = detail.contactId ?? 'unknown';
  const attrs = detail.contactData?.attributes ?? {};
  const documentId = (attrs.documentId ?? attrs.documento ?? '').trim() || 'unknown';
  const transcript = (detail.transcript ?? attrs.transcript ?? '').trim();
  const now = new Date().toISOString();

  console.info(JSON.stringify({ msg: 'post-contact start', contactId, eventType: detail.eventType }));

  let summary: Summary | null = null;
  let summaryStatus = 'skipped';
  if (transcript) {
    summary = await summarizeWithBedrock(transcript, {
      contactId,
      patientName: attrs.patientName ?? '',
      patientType: attrs.patientType ?? '',
      lookupStatus: attrs.lookupStatus ?? '',
    });
    summaryStatus = summary ? 'generated' : 'error';
  }

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `PATIENT#${documentId}`,
        sk: `INTERACTION#${contactId}`,
        contactId,
        instanceId: detail.instanceId ?? '',
        eventType: detail.eventType ?? '',
        connectedAt: detail.connectedToSystemTimestamp ?? '',
        disconnectedAt: detail.disconnectTimestamp ?? now,
        createdAt: now,
        attributes: attrs,
        recordingBucket: process.env.RECORDINGS_BUCKET ?? '',
        summaryStatus,
        ...(summary ? { summary: summary } : {}),
      },
    }),
  );

  console.info(JSON.stringify({ msg: 'post-contact ok', contactId, summaryStatus }));
  return { ok: true, summaryStatus };
};
