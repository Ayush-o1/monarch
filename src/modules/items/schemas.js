import { z } from 'zod';

export const VALID_CONDITIONS = ['good', 'minor_wear', 'damaged', 'missing'];

export const createItemSchema = z
  .object({
    room: z
      .string({ required_error: 'Room is required' })
      .trim()
      .min(1, 'Room must be at least 1 character')
      .max(80, 'Room must be at most 80 characters'),
    name: z
      .string({ required_error: 'Item name is required' })
      .trim()
      .min(1, 'Item name must be at least 1 character')
      .max(80, 'Item name must be at most 80 characters'),
    condition: z
      .enum(VALID_CONDITIONS, {
        errorMap: () => ({
          message:
            'Condition must be one of: good, minor_wear, damaged, missing',
        }),
      })
      .nullable()
      .optional(),
    note: z
      .string()
      .max(1000, 'Note must be at most 1000 characters')
      .nullable()
      .optional(),
  })
  .strict();

export const patchItemSchema = z
  .object({
    room: z
      .string()
      .trim()
      .min(1, 'Room must be at least 1 character')
      .max(80, 'Room must be at most 80 characters')
      .optional(),
    name: z
      .string()
      .trim()
      .min(1, 'Item name must be at least 1 character')
      .max(80, 'Item name must be at most 80 characters')
      .optional(),
    condition: z
      .enum(VALID_CONDITIONS, {
        errorMap: () => ({
          message:
            'Condition must be one of: good, minor_wear, damaged, missing',
        }),
      })
      .nullable()
      .optional(),
    note: z
      .string()
      .max(1000, 'Note must be at most 1000 characters')
      .nullable()
      .optional(),
  })
  .strict();

export const idParamSchema = z
  .object({
    id: z.string().uuid('Invalid ID format'),
  })
  .strict();
