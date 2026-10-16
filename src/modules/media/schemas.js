import { z } from 'zod';

export const mediaIdParamSchema = z.object({
  id: z.string().uuid('Invalid ID format'),
});
