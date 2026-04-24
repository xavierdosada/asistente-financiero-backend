import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { AuthenticatedRequest } from './auth.types';

@Injectable()
export class SupabaseAuthGuard implements CanActivate, OnModuleInit {
  private supabase!: SupabaseClient;

  constructor(private readonly reflector: Reflector) {}

  onModuleInit() {
    const url = process.env.SUPABASE_URL?.trim();
    const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
    if (!url || !anonKey) {
      throw new Error('Definí SUPABASE_URL y SUPABASE_ANON_KEY para validar JWT.');
    }
    this.supabase = createClient(url, anonKey);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = this.getAuthorizationHeader(request);
    const token = this.extractBearerToken(authHeader);
    if (!token) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data?.user?.id) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    request.user = {
      id: data.user.id,
      email: data.user.email,
    };
    return true;
  }

  private getAuthorizationHeader(request: AuthenticatedRequest): string {
    const value = request.headers?.authorization;
    if (Array.isArray(value)) return value[0] ?? '';
    return value ?? '';
  }

  private extractBearerToken(authHeader: string): string | null {
    const value = authHeader.trim();
    if (!value.toLowerCase().startsWith('bearer ')) return null;
    const token = value.slice('bearer '.length).trim();
    return token || null;
  }
}
