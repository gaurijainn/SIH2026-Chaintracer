import { z } from 'zod';
import { isRole, type Role } from '@/stores/auth';

/** Same bounds as the API's loginBody (apps/api/src/auth/routes.ts). */
export const loginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address').max(254, 'Email address is too long').pipe(z.email('Enter a valid email address')),
  password: z.string().min(1, 'Enter your password').max(256, 'Password is too long'),
});
export type LoginValues = z.infer<typeof loginSchema>;

/** Shape of a successful POST /auth/login (or /auth/refresh) response; anything else is treated as a failed login. */
export const loginResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  user: z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.custom<Role>(isRole) }),
});
