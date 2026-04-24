import { HttpException, HttpStatus } from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.types';

export function getAuthenticatedUserId(request: AuthenticatedRequest): string {
  const userId = request.user?.id?.trim();
  if (!userId) {
    throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
  }
  return userId;
}
