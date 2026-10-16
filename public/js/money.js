export function parseRupeesToPaise(input) {
  if (input === null || input === undefined) {
    throw new Error('Invalid rupee amount: input is empty');
  }

  const str = String(input).trim().replace(/,/g, '');

  if (!str) {
    throw new Error('Invalid rupee amount: input is empty');
  }

  // Must match integer or up to two decimal places, non-negative
  if (!/^\d+(\.\d{1,2})?$/.test(str)) {
    throw new Error(`Invalid rupee amount: "${input}"`);
  }

  const parts = str.split('.');
  const whole = parts[0];
  const decimal = parts[1] || '';

  const wholePaise = BigInt(whole) * 100n;
  const decimalPaise = BigInt(decimal.padEnd(2, '0'));
  const totalPaise = wholePaise + decimalPaise;

  if (totalPaise <= 0n) {
    throw new Error(
      `Invalid rupee amount: "${input}" must be greater than zero`
    );
  }

  if (totalPaise > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Rupee amount exceeds maximum supported value');
  }

  return Number(totalPaise);
}

export function formatPaise(paise) {
  const num = Number(paise);
  if (Number.isNaN(num)) {
    return '₹0.00';
  }

  const rupees = num / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}
