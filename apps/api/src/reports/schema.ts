import { z } from 'zod';

/**
 * `evidence.v1` -- the versioned, canonicalizable shape produced by `collector.ts` and consumed by
 * `pdf.ts`/`/verify`. Every field that has no backing data in the case's own tables is `null`
 * (never omitted where the shape expects it, and never invented) so the schema always validates and
 * the canonical hash is stable regardless of how much data a given case actually has.
 */

const istTimestampSchema = z.object({
  iso: z.string(),
  display: z.string(),
});

const caseSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  firNumber: z.string().nullable(),
  ackNo: z.string().nullable(),
});

const victimTransactionSchema = z.object({
  chain: z.string().nullable(),
  address: z.string().nullable(),
  ackNo: z.string().nullable(),
  amountInr: z.string().nullable(),
  reportedAt: z.string().nullable(),
});

const hopSchema = z.object({
  hopNo: z.number(),
  chain: z.string(),
  from: z.string(),
  to: z.string(),
  txHash: z.string(),
  token: z.string(),
  amount: z.string(),
  usd: z.string().nullable(),
  amountInr: z.string().nullable(),
  tsUtc: z.string(),
  tsIst: istTimestampSchema,
  explorerUrl: z.string().nullable(),
});

const graphNodeSchema = z.object({
  chain: z.string(),
  addr: z.string(),
  entity: z.object({ name: z.string(), type: z.string() }).nullable(),
});

const graphEdgeSchema = z.object({
  chain: z.string(),
  from: z.string(),
  to: z.string(),
  tx: z.string(),
  idx: z.number(),
  token: z.string(),
  amount: z.string(),
  usd: z.string().nullable(),
  ts: z.string(),
});

const attributionSchema = z.object({
  chain: z.string(),
  addr: z.string(),
  vaspId: z.string(),
  vaspName: z.string(),
  confidence: z.number(),
  heuristics: z.unknown(),
});

const riskSchema = z.object({
  chain: z.string(),
  addr: z.string(),
  score: z.number(),
  band: z.string(),
  factors: z.unknown(),
  typology: z.string().nullable(),
  typologyConfidence: z.number().nullable(),
  modelVersion: z.string(),
  createdAt: z.string(),
});

const sourceSchema = z.object({
  provider: z.string(),
  retrievedAt: z.string(),
});

const methodologySchema = z.object({
  taintModel: z.string().nullable(),
  maxHops: z.number().nullable(),
  minValueUsd: z.string().nullable(),
  windowDays: z.number().nullable(),
  description: z.string(),
});

export const evidenceV1Schema = z.object({
  schemaVersion: z.literal('evidence.v1'),
  generatedAt: z.string(),
  case: caseSchema,
  victimTransaction: victimTransactionSchema.nullable(),
  hops: z.array(hopSchema),
  graph: z.object({ nodes: z.array(graphNodeSchema), edges: z.array(graphEdgeSchema) }),
  attribution: z.array(attributionSchema),
  risk: z.array(riskSchema),
  sources: z.array(sourceSchema),
  methodology: methodologySchema,
  limitations: z.array(z.string()),
});

export type EvidenceV1 = z.infer<typeof evidenceV1Schema>;
