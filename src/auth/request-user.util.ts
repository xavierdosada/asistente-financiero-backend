import { HttpException, HttpStatus } from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.types';

export function getAuthenticatedUserId(request: AuthenticatedRequest): string {
  const userId = request.user?.id?.trim();
  if (userId) {
    return userId;
  }

  const authHeader = readAuthorizationHeader(request);
  const token = extractBearerToken(authHeader);
  const fallbackUserId = token ? readJwtSubWithoutVerification(token) : null;
  if (!fallbackUserId) {
    throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
  }
  return fallbackUserId;
}

function readAuthorizationHeader(request: AuthenticatedRequest): string {
  const value = request.headers?.authorization;
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function extractBearerToken(authHeader: string): string | null {
  const value = authHeader.trim();
  if (!value.toLowerCase().startsWith('bearer ')) return null;
  const token = value.slice('bearer '.length).trim();
  return token || null;
}

function readJwtSubWithoutVerification(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = decodeBase64Url(parts[1]);
    const parsed = JSON.parse(payload) as { sub?: unknown };
    return typeof parsed.sub === 'string' && parsed.sub.trim() ? parsed.sub : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}
