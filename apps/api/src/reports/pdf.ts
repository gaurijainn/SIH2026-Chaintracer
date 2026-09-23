import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import QRCode from 'qrcode';
import type { EvidenceV1 } from './schema';
import { ReportGenerationError } from './errors';

const TEMPLATE_DIR = new URL('./templates/', import.meta.url);

export interface ReportIntegrity {
  reportId: string;
  sha256: string;
}

/** QR payload per plan: minimal, no PII -- just enough for /verify to look the report back up. */
export interface QrPayload {
  v: 'evidence.v1';
  caseId: string;
  reportId: string;
  sha256: string;
}

export async function renderQrCode(payload: QrPayload): Promise<Buffer> {
  return QRCode.toBuffer(JSON.stringify(payload), { type: 'png', width: 256, margin: 1 });
}

let compiledTemplate: HandlebarsTemplateDelegate | null = null;
let compiledCertificate: HandlebarsTemplateDelegate | null = null;
let printCss: string | null = null;

async function getTemplates() {
  if (!compiledTemplate || !compiledCertificate || printCss === null) {
    const [tpl, cert, css] = await Promise.all([
      readFile(fileURLToPath(new URL('evidence.hbs', TEMPLATE_DIR)), 'utf8'),
      readFile(fileURLToPath(new URL('certificate-section.hbs', TEMPLATE_DIR)), 'utf8'),
      readFile(fileURLToPath(new URL('print.css', TEMPLATE_DIR)), 'utf8'),
    ]);
    compiledTemplate = Handlebars.compile(tpl);
    compiledCertificate = Handlebars.compile(cert);
    printCss = css;
  }
  return { evidenceTpl: compiledTemplate, certificateTpl: compiledCertificate, printCss };
}

/** Renders evidence + integrity info to HTML (used directly by renderPdf, exported for tests that don't want a headless browser). */
export async function renderHtml(evidence: EvidenceV1, integrity: ReportIntegrity, qrDataUri: string | null): Promise<string> {
  const { evidenceTpl, certificateTpl, printCss: css } = await getTemplates();
  const certificateSection = certificateTpl({ ...evidence, integrity });
  return evidenceTpl({ ...evidence, integrity: { ...integrity, qrDataUri }, certificateSection, printCss: css });
}

/**
 * Handlebars -> HTML -> Puppeteer PDF, with the QR code (payload = {v, caseId, reportId, sha256},
 * no PII) and SHA-256 footer baked into the page before printing. Puppeteer's Chromium binary is
 * expected to be provided by the runtime (see Dockerfile.node's `apk add chromium` +
 * PUPPETEER_EXECUTABLE_PATH for the container image); if no browser is available (e.g. a bare
 * local/test environment that never downloaded/installed one), this throws ReportGenerationError
 * rather than silently producing a broken PDF.
 */
export async function renderPdf(evidence: EvidenceV1, integrity: ReportIntegrity): Promise<Buffer> {
  const qrPayload: QrPayload = { v: 'evidence.v1', caseId: evidence.case.id, reportId: integrity.reportId, sha256: integrity.sha256 };
  const qrPng = await renderQrCode(qrPayload);
  const qrDataUri = `data:image/png;base64,${qrPng.toString('base64')}`;
  const html = await renderHtml(evidence, integrity, qrDataUri);

  let puppeteer: typeof import('puppeteer');
  try {
    puppeteer = await import('puppeteer');
  } catch (e) {
    throw new ReportGenerationError('puppeteer is not installed', e);
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (e) {
    throw new ReportGenerationError('failed to launch headless Chromium for PDF rendering (is a Chromium binary installed? see Dockerfile.node / PUPPETEER_EXECUTABLE_PATH)', e);
  }

  try {
    const page = await browser.newPage();
    // No external resources are loaded by the template (styles/QR are inlined), so 'load' is
    // sufficient and avoids depending on a 'networkidle0' waitUntil value some puppeteer type
    // versions don't accept for setContent.
    await page.setContent(html, { waitUntil: 'load' });
    const buffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
    return Buffer.from(buffer);
  } catch (e) {
    throw new ReportGenerationError('PDF rendering failed', e);
  } finally {
    await browser.close();
  }
}
