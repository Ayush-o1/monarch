import { z } from 'zod';

export const createTenancySchema = z
  .object({
    propertyLabel: z
      .string({
        required_error: 'Property label is required',
        invalid_type_error: 'Property label must be a string',
      })
      .trim()
      .min(1, 'Property label must be at least 1 character')
      .max(80, 'Property label must be at most 80 characters'),
    address: z
      .string({ invalid_type_error: 'Address must be a string' })
      .trim()
      .max(300, 'Address must be at most 300 characters')
      .optional()
      .nullable(),
    landlordName: z
      .string({ invalid_type_error: 'Landlord name must be a string' })
      .trim()
      .max(80, 'Landlord name must be at most 80 characters')
      .optional()
      .nullable(),
    depositPaise: z
      .number({
        required_error: 'Deposit in paise is required',
        invalid_type_error: 'Deposit in paise must be an integer number',
      })
      .int('Deposit in paise must be an integer')
      .min(1, 'Deposit in paise must be at least 1')
      .max(1000000000, 'Deposit in paise cannot exceed 1,000,000,000'),
    refundWindowDays: z
      .number({
        invalid_type_error: 'Refund window must be an integer number of days',
      })
      .int('Refund window must be an integer')
      .min(1, 'Refund window must be at least 1 day')
      .max(365, 'Refund window must be at most 365 days')
      .optional()
      .nullable(),
    leaseStartDate: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}$/,
        'Lease start date must be a valid date in YYYY-MM-DD format'
      )
      .refine((val) => !val || !Number.isNaN(Date.parse(val)), {
        message: 'Lease start date must be a valid calendar date',
      })
      .optional()
      .nullable(),
  })
  .strict()
  .transform((data) => {
    const propertyLabel = data.propertyLabel.trim();
    const address = data.address ? data.address.trim() : null;
    const landlordName = data.landlordName
      ? data.landlordName.trim() || null
      : null;
    const depositPaise = data.depositPaise;
    const refundWindowDays = data.refundWindowDays ?? null;
    const leaseStartDate = data.leaseStartDate ?? null;

    return {
      propertyLabel,
      property_label: propertyLabel,
      address,
      landlordName,
      landlord_name: landlordName,
      depositPaise,
      deposit_paise: depositPaise,
      refundWindowDays,
      refund_window_days: refundWindowDays,
      leaseStartDate,
      lease_start_date: leaseStartDate,
    };
  });

export const tenancyIdParamSchema = z
  .object({
    id: z.string().uuid('Invalid tenancy ID format'),
  })
  .strict();
