import { z } from 'zod';

export const proposeDeductionSchema = z.object({
  name: z
    .string({ required_error: 'name is required' })
    .transform((val) => val.trim())
    .refine((val) => val.length >= 1 && val.length <= 80, {
      message: 'name must be between 1 and 80 characters',
    }),
  description: z
    .string({ required_error: 'description is required' })
    .transform((val) => val.trim())
    .refine((val) => val.length >= 1 && val.length <= 300, {
      message: 'description must be between 1 and 300 characters',
    }),
  amountPaise: z
    .number({ required_error: 'amountPaise is required' })
    .int({ message: 'amountPaise must be an integer' })
    .min(1, { message: 'amountPaise must be at least 1' })
    .max(1000000000, { message: 'amountPaise cannot exceed 1,000,000,000' }),
  itemId: z
    .string()
    .uuid({ message: 'itemId must be a valid UUID' })
    .optional()
    .nullable(),
});

export const respondDeductionSchema = z
  .object({
    action: z.enum(['accept', 'dispute'], {
      required_error: 'action must be either accept or dispute',
    }),
    note: z
      .string()
      .max(500, { message: 'note must be at most 500 characters' })
      .optional()
      .nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.action === 'dispute') {
      const trimmedNote = (data.note || '').trim();
      if (trimmedNote.length < 1 || trimmedNote.length > 500) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'note is required when disputing a deduction and must be between 1 and 500 characters',
          path: ['note'],
        });
      }
    }
  });

export const withdrawDeductionSchema = z.object({
  name: z.string().max(80).optional().nullable(),
});

export const closeTenancySchema = z.object({
  acknowledgeUnresolved: z.boolean().optional(),
});
