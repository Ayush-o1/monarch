import { z } from 'zod';

export const createTenancySchema = z
  .object({
    property_label: z
      .string({ invalid_type_error: 'Property label must be a string' })
      .trim()
      .min(1, 'Property label must be at least 1 character')
      .max(80, 'Property label must be at most 80 characters')
      .optional(),
    propertyLabel: z
      .string({ invalid_type_error: 'Property label must be a string' })
      .trim()
      .min(1, 'Property label must be at least 1 character')
      .max(80, 'Property label must be at most 80 characters')
      .optional(),
    address: z
      .string({ invalid_type_error: 'Address must be a string' })
      .trim()
      .max(300, 'Address must be at most 300 characters')
      .optional()
      .nullable(),
    landlord_name: z
      .string({ invalid_type_error: 'Landlord name must be a string' })
      .trim()
      .max(80, 'Landlord name must be at most 80 characters')
      .optional()
      .nullable(),
    landlordName: z
      .string({ invalid_type_error: 'Landlord name must be a string' })
      .trim()
      .max(80, 'Landlord name must be at most 80 characters')
      .optional()
      .nullable(),
    deposit_paise: z
      .number({
        invalid_type_error: 'Deposit in paise must be an integer number',
      })
      .int('Deposit in paise must be an integer')
      .min(1, 'Deposit in paise must be at least 1')
      .max(1000000000, 'Deposit in paise cannot exceed 1,000,000,000')
      .optional(),
    depositPaise: z
      .number({
        invalid_type_error: 'Deposit in paise must be an integer number',
      })
      .int('Deposit in paise must be an integer')
      .min(1, 'Deposit in paise must be at least 1')
      .max(1000000000, 'Deposit in paise cannot exceed 1,000,000,000')
      .optional(),
    refund_window_days: z
      .number({
        invalid_type_error: 'Refund window must be an integer number of days',
      })
      .int('Refund window must be an integer')
      .min(1, 'Refund window must be at least 1 day')
      .max(365, 'Refund window must be at most 365 days')
      .optional()
      .nullable(),
    refundWindowDays: z
      .number({
        invalid_type_error: 'Refund window must be an integer number of days',
      })
      .int('Refund window must be an integer')
      .min(1, 'Refund window must be at least 1 day')
      .max(365, 'Refund window must be at most 365 days')
      .optional()
      .nullable(),
    lease_start_date: z
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
  .superRefine((data, ctx) => {
    if (data.property_label === undefined && data.propertyLabel === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['property_label'],
        message: 'Property label is required',
      });
    }
    if (data.deposit_paise === undefined && data.depositPaise === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deposit_paise'],
        message: 'Deposit in paise is required',
      });
    }
  })
  .transform((data) => {
    const propertyLabel = (
      data.property_label ??
      data.propertyLabel ??
      ''
    ).trim();
    const address = data.address ? data.address.trim() : null;
    const landlordName =
      (data.landlord_name ?? data.landlordName ?? '').trim() || null;
    const depositPaise = data.deposit_paise ?? data.depositPaise;
    const refundWindowDays =
      data.refund_window_days !== undefined
        ? data.refund_window_days
        : data.refundWindowDays !== undefined
          ? data.refundWindowDays
          : null;
    const leaseStartDate = data.lease_start_date ?? data.leaseStartDate ?? null;

    return {
      property_label: propertyLabel,
      propertyLabel,
      address,
      landlord_name: landlordName,
      landlordName,
      deposit_paise: depositPaise,
      depositPaise,
      refund_window_days: refundWindowDays,
      refundWindowDays,
      lease_start_date: leaseStartDate,
      leaseStartDate,
    };
  });

export const tenancyIdParamSchema = z.object({
  id: z.string().uuid('Invalid tenancy ID format'),
});
