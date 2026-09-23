import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { Driver } from 'neo4j-driver';
import { canonicalize, sha256Hex } from '@ps26183/shared';
import type { AuditService } from '../audit/service';
import { collectEvidence } from './collector';
import { EvidenceNotFoundError, ReportGenerationError } from './errors';
import { renderPdf } from './pdf';
import { evidenceV1Schema, type EvidenceV1 } from './schema';
import { REPORT_FIR_PII_CONTEXT, type PiiCipher } from '../auth/pii';

export interface GenerateReportInput {
  format: 'json' | 'pdf';
  actorId?: string;
}

export interface GenerateReportResult {
  report: { id: string; caseId: string; version: string; sha256: string; pdfPath: string | null; createdAt: Date };
  json: EvidenceV1;
  /** the value substituted for case.firNumber when the hash was computed (ciphertext when PII encryption is on) */
  integrity: { firNumberAsHashed: string | null };
  pdfBuffer?: Buffer;
}

export interface VerifyResult {
  match: boolean;
  report: { id: string; caseId: string; version: string; sha256: string; createdAt: Date } | null;
}

export interface ReportServiceDeps {
  prisma: PrismaClient;
  driver: Driver;
  audit: AuditService;
  pii?: PiiCipher;
  /** Directory PDF exports are written to. Defaults to <cwd>/reports-output. */
  outputDir?: string;
}

/**
 * B9 evidence-report generator: collect -> validate -> canonicalize+hash -> persist `Report` ->
 * optionally render a PDF (with QR + footer hash baked in) -> audit. `verify` recomputes the hash
 * of a stored report's payload and reports whether it still matches what was persisted -- this is
 * the tamper check surfaced at `GET /verify/:hash`.
 */
export class ReportService {
  constructor(private readonly deps: ReportServiceDeps) {}

  async generate(caseId: string, input: GenerateReportInput): Promise<GenerateReportResult> {
    const rawEvidence = await collectEvidence({ prisma: this.deps.prisma, driver: this.deps.driver, pii: this.deps.pii }, caseId);
    const parsed = evidenceV1Schema.safeParse(rawEvidence);
    if (!parsed.success) {
      throw new ReportGenerationError(`collected evidence failed schema validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const evidence = parsed.data;

    // B10: the persisted (and hashed) document carries the FIR reference only as AES-256-GCM ciphertext, so plaintext
    // never lands in Report.payload. The hash is the usual SHA-256 of the canonical JSON of that persisted form, so
    // /verify recomputes it unchanged. The caller still receives the readable evidence plus the exact value that was
    // hashed in place of the FIR, which lets a recipient recompute the hash from the exported JSON.
    const hashedFir = this.deps.pii && evidence.case.firNumber ? this.deps.pii.encrypt(evidence.case.firNumber, REPORT_FIR_PII_CONTEXT) : evidence.case.firNumber;
    const persisted: EvidenceV1 = { ...evidence, case: { ...evidence.case, firNumber: hashedFir } };

    const canonical = canonicalize(persisted);
    const sha256 = sha256Hex(canonical);

    const created = await this.deps.prisma.report.create({
      data: {
        caseId,
        version: 'evidence.v1',
        sha256,
        payload: persisted as unknown as object,
        createdById: input.actorId ?? null,
      },
    });

    await this.deps.audit.record({ actorId: input.actorId, action: 'evidence generated', entity: 'Report', entityId: created.id, meta: { caseId, sha256 } });

    let pdfBuffer: Buffer | undefined;
    let pdfPath: string | null = null;
    if (input.format === 'pdf') {
      pdfBuffer = await this.renderPdfSafely(evidence, { reportId: created.id, sha256 });
      const dir = this.deps.outputDir ?? path.join(process.cwd(), 'reports-output');
      await mkdir(dir, { recursive: true });
      pdfPath = path.join(dir, `${created.id}.pdf`);
      await writeFile(pdfPath, pdfBuffer);
      await this.deps.prisma.report.update({ where: { id: created.id }, data: { pdfPath } });
    }

    await this.deps.audit.record({ actorId: input.actorId, action: 'evidence exported', entity: 'Report', entityId: created.id, meta: { caseId, format: input.format, sha256 } });

    return {
      report: { id: created.id, caseId, version: 'evidence.v1', sha256, pdfPath, createdAt: created.createdAt },
      json: evidence,
      integrity: { firNumberAsHashed: hashedFir },
      pdfBuffer,
    };
  }

  private async renderPdfSafely(evidence: EvidenceV1, integrity: { reportId: string; sha256: string }): Promise<Buffer> {
    return renderPdf(evidence, integrity);
  }

  async verify(sha256: string, actorId?: string): Promise<VerifyResult> {
    const report = await this.deps.prisma.report.findFirst({ where: { sha256 }, orderBy: { createdAt: 'desc' } });
    if (!report) throw new EvidenceNotFoundError(sha256);

    const recomputed = sha256Hex(canonicalize(report.payload));
    const match = recomputed === report.sha256 && recomputed === sha256;

    await this.deps.audit.record({
      actorId,
      action: 'evidence verified',
      entity: 'Report',
      entityId: report.id,
      meta: { caseId: report.caseId, requestedHash: sha256, match },
    });

    return { match, report: { id: report.id, caseId: report.caseId, version: report.version, sha256: report.sha256, createdAt: report.createdAt } };
  }
}
