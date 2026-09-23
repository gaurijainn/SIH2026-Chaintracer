import { z } from 'zod';
import { ACK_RE, MAX_ENTRIES, classifyIdentifier, clean, dateProblem, parseAmountInr, toList } from './rules';

export type IntakeMode = 'single' | 'paste';

export const NETWORK_CHOICES = ['', 'TRC20', 'ERC20', 'BEP20'] as const;

/** Same bounds as the API (apps/api/src/intake/normalize.ts); the API re-validates everything, including address checksums. */
export function makeComplaintSchema(mode: IntakeMode) {
  return z
    .object({
      ackNo: z.string().trim().min(1, 'Enter the NCRP acknowledgement number').regex(ACK_RE, 'Use 3-64 letters, digits or . _ / -'),
      reportedAt: z.string().trim().min(1, 'Enter the complaint date'),
      amountInr: z.string().trim().min(1, 'Enter the amount in INR'),
      category: z.string().trim().min(1, 'Enter the complaint category').max(100, 'Category is limited to 100 characters'),
      network: z.enum(NETWORK_CHOICES),
      addresses: z.string(),
      firNumber: z.string().trim().max(64, 'FIR number is limited to 64 characters'),
    })
    .superRefine((v, ctx) => {
      const add = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
      if (v.reportedAt.trim()) {
        const p = dateProblem(v.reportedAt, new Date());
        if (p) add('reportedAt', p.message);
      }
      if (v.amountInr.trim() && !parseAmountInr(v.amountInr)) add('amountInr', 'Enter a positive amount with at most 2 decimals');
      const items = mode === 'single' ? [v.addresses].filter((a) => clean(a)) : toList(v.addresses);
      if (mode === 'single' && toList(v.addresses).length > 1) add('addresses', 'Enter one address here, or use the Paste addresses tab for several');
      else if (items.length === 0) add('addresses', mode === 'single' ? 'Enter the suspect wallet address' : 'Paste at least one address');
      else if (items.length > MAX_ENTRIES) add('addresses', `At most ${MAX_ENTRIES} addresses per complaint`);
      else {
        const bad = items.map(classifyIdentifier).find((c) => c.kind === 'INVALID');
        if (bad && bad.kind === 'INVALID') add('addresses', `${bad.normalized || 'Address'}: ${bad.reason}`);
      }
    });
}
export type ComplaintFormValues = z.infer<ReturnType<typeof makeComplaintSchema>>;

export const emptyComplaint: ComplaintFormValues = { ackNo: '', reportedAt: '', amountInr: '', category: '', network: '', addresses: '', firNumber: '' };

/** Body for POST /api/v1/complaints (complaintBody in apps/api/src/intake/routes.ts). Empty optionals are omitted. */
export function toComplaintPayload(v: ComplaintFormValues, addresses: string[]) {
  return {
    ackNo: v.ackNo.trim(),
    reportedAt: v.reportedAt.trim(),
    category: v.category.trim(),
    amountInr: v.amountInr.trim(),
    addresses,
    ...(v.network ? { network: v.network } : {}),
    ...(v.firNumber.trim() ? { firNumber: v.firNumber.trim() } : {}),
  };
}

export const CATEGORY_SUGGESTIONS = ['Investment fraud', 'Phishing', 'Romance scam', 'Job scam', 'Ransomware', 'Sextortion'];
