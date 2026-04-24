import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Put,
} from '@nestjs/common';
import { ProcessChatMessageUseCase } from '../../application/process-chat-message.use-case';
import {
  CHAT_PREFERENCES_REPOSITORY,
  ChatPreferencesPatch,
  ChatPreferencesRepositoryPort,
} from '../../domain/ports/chat-preferences.repository.port';
import { isEntryMode, type EntryMode } from '../../domain/ports/entry-mode.port';

class ChatMessageDto {
  message!: string;
  auto_create_category?: boolean;
  entry_mode?: string;
  /** ARS por 1 USD para este mensaje (gasto con tarjeta en USD). */
  usd_ars_rate?: number;
}

class ChatPreferencesDto {
  auto_create_category_default?: boolean;
  default_entry_mode?: string;
  /** ARS por 1 USD (preferencia por defecto). */
  default_usd_ars_rate?: number | null;
}

@Controller('chat')
export class ChatController {
  constructor(
    private readonly processChat: ProcessChatMessageUseCase,
    @Inject(CHAT_PREFERENCES_REPOSITORY)
    private readonly chatPreferences: ChatPreferencesRepositoryPort,
  ) {}

  @Get('preferences')
  async getPreferences() {
    try {
      return await this.chatPreferences.get();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Put('preferences')
  async updatePreferences(@Body() body: ChatPreferencesDto) {
    const hasAutoCreate = body?.auto_create_category_default !== undefined;
    const hasDefaultEntryMode = body?.default_entry_mode !== undefined;
    const hasUsdArs = body?.default_usd_ars_rate !== undefined;
    if (!hasAutoCreate && !hasDefaultEntryMode && !hasUsdArs) {
      throw new HttpException(
        'Enviá al menos uno de: auto_create_category_default, default_entry_mode, default_usd_ars_rate',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      hasAutoCreate &&
      typeof body.auto_create_category_default !== 'boolean'
    ) {
      throw new HttpException(
        'Campo "auto_create_category_default" debe ser booleano',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      hasDefaultEntryMode &&
      (typeof body.default_entry_mode !== 'string' ||
        !isEntryMode(body.default_entry_mode))
    ) {
      throw new HttpException(
        'Campo "default_entry_mode" debe ser operativo o historico',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (hasUsdArs && body.default_usd_ars_rate !== null) {
      if (typeof body.default_usd_ars_rate !== 'number' || !Number.isFinite(body.default_usd_ars_rate)) {
        throw new HttpException(
          'Campo "default_usd_ars_rate" debe ser numérico o null',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (body.default_usd_ars_rate <= 0) {
        throw new HttpException(
          'Campo "default_usd_ars_rate" debe ser mayor a 0 o null',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    const defaultEntryMode: EntryMode | undefined =
      hasDefaultEntryMode && isEntryMode(body.default_entry_mode)
        ? body.default_entry_mode
        : undefined;
    const patch: ChatPreferencesPatch = {
      auto_create_category_default: body.auto_create_category_default,
      default_entry_mode: defaultEntryMode,
      default_usd_ars_rate: hasUsdArs ? body.default_usd_ars_rate ?? null : undefined,
    };
    try {
      return await this.chatPreferences.update(patch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('messages')
  async postMessage(@Body() body: ChatMessageDto) {
    const message = body?.message;
    const autoCreateCategory = body?.auto_create_category;
    const rawEntryMode = body?.entry_mode;
    if (typeof message !== 'string') {
      throw new HttpException('Campo "message" requerido', HttpStatus.BAD_REQUEST);
    }
    if (
      autoCreateCategory !== undefined &&
      typeof autoCreateCategory !== 'boolean'
    ) {
      throw new HttpException(
        'Campo "auto_create_category" debe ser booleano',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      rawEntryMode !== undefined &&
      (typeof rawEntryMode !== 'string' || !isEntryMode(rawEntryMode))
    ) {
      throw new HttpException(
        'Campo "entry_mode" debe ser operativo o historico',
        HttpStatus.BAD_REQUEST,
      );
    }
    const rawUsdArs = body?.usd_ars_rate;
    if (
      rawUsdArs !== undefined &&
      (typeof rawUsdArs !== 'number' || !Number.isFinite(rawUsdArs) || rawUsdArs <= 0)
    ) {
      throw new HttpException(
        'Campo "usd_ars_rate" debe ser un número mayor a 0 cuando se envía',
        HttpStatus.BAD_REQUEST,
      );
    }
    const entryMode: EntryMode | undefined =
      rawEntryMode !== undefined && isEntryMode(rawEntryMode)
        ? rawEntryMode
        : undefined;

    try {
      const result = await this.processChat.execute(message, {
        autoCreateCategory,
        entryMode,
        usdArsRate: typeof rawUsdArs === 'number' && Number.isFinite(rawUsdArs) ? rawUsdArs : undefined,
      });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
