/** Well-known, checksum-valid public addresses used as test inputs (no provider calls are made with them). */
export const TRON_A = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const TRON_B = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
export const ETH_A = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
export const BTC_A = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

export const HEADER = 'ackNo,reportedAt,category,amountInr,network,addresses';
export const csvFile = (text: string, name = 'complaints.csv') => new File([text], name, { type: 'text/csv' });
