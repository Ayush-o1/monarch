import { z } from 'zod';

export const registerSchema = z
  .object({
    name: z
      .string({ required_error: 'Name is required' })
      .trim()
      .min(1, 'Name must be at least 1 character')
      .max(80, 'Name must be at most 80 characters'),
    email: z
      .string({ required_error: 'Email is required' })
      .trim()
      .toLowerCase()
      .email('Invalid email address')
      .min(3, 'Email must be at least 3 characters')
      .max(255, 'Email must be at most 255 characters'),
    password: z
      .string({ required_error: 'Password is required' })
      .min(10, 'Password must be at least 10 characters')
      .refine((val) => Buffer.byteLength(val, 'utf8') <= 72, {
        message: 'Password must be at most 72 bytes',
      }),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z
      .string({ required_error: 'Email is required' })
      .trim()
      .toLowerCase()
      .email('Invalid email address'),
    password: z
      .string({ required_error: 'Password is required' })
      .min(1, 'Password is required'),
  })
  .strict();
