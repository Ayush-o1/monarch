import { z } from 'zod';

export const acknowledgeSchema = z.object({
  name: z
    .string({ required_error: 'Name is required' })
    .trim()
    .min(1, 'Name is required')
    .max(80, 'Name must be at most 80 characters'),
});

export const requestChangesSchema = z.object({
  name: z
    .string({ required_error: 'Name is required' })
    .trim()
    .min(1, 'Name is required')
    .max(80, 'Name must be at most 80 characters'),
  note: z
    .string({ required_error: 'Note is required' })
    .trim()
    .min(1, 'Note is required')
    .max(1000, 'Note must be at most 1000 characters'),
});
