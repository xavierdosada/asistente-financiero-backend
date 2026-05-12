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
import {
  ProcessChatMessageUseCase,
  type ProcessChatMessageOptions,
} from '../../application/process-chat-message.use-case';
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
  /** Prioridad explícita del medio seleccionado por el usuario. */
  payment_method?: string;
  /** Tarjeta seleccionada por el usuario cuando usa medio tarjeta. */
  card_id?: string;
  /** Confirmación explícita para registrar en efectivo aunque el texto mencione cuotas. */
  allow_cash_installment?: boolean;
  /** Tras confirmación UI: impacto de cuota no inicial en resúmenes. */
  installment_statement_impact?: string;
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
    const rawPaymentMethod = body?.payment_method;
    const rawCardId = body?.card_id;
    const allowCashInstallment = body?.allow_cash_installment;
    const rawInstallmentImpact = body?.installment_statement_impact;
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
    if (
      rawPaymentMethod !== undefined &&
      rawPaymentMethod !== 'efectivo' &&
      rawPaymentMethod !== 'tarjeta'
    ) {
      throw new HttpException(
        'Campo "payment_method" debe ser efectivo o tarjeta',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (rawCardId !== undefined && typeof rawCardId !== 'string') {
      throw new HttpException(
        'Campo "card_id" debe ser string cuando se envía',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      allowCashInstallment !== undefined &&
      typeof allowCashInstallment !== 'boolean'
    ) {
      throw new HttpException(
        'Campo "allow_cash_installment" debe ser booleano',
        HttpStatus.BAD_REQUEST,
      );
    }
    const paymentMethod =
      rawPaymentMethod === 'efectivo' || rawPaymentMethod === 'tarjeta'
        ? rawPaymentMethod
        : undefined;
    const cardId = typeof rawCardId === 'string' ? rawCardId.trim() : '';
    if (paymentMethod === 'tarjeta' && !cardId) {
      throw new HttpException(
        'Campo "card_id" es requerido cuando payment_method=tarjeta',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      rawInstallmentImpact !== undefined &&
      rawInstallmentImpact !== 'closed_statement' &&
      rawInstallmentImpact !== 'next_statement'
    ) {
      throw new HttpException(
        'Campo "installment_statement_impact" debe ser closed_statement o next_statement',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const options: ProcessChatMessageOptions = {};
      if (autoCreateCategory !== undefined) options.autoCreateCategory = autoCreateCategory;
      if (entryMode !== undefined) options.entryMode = entryMode;
      if (typeof rawUsdArs === 'number' && Number.isFinite(rawUsdArs)) {
        options.usdArsRate = rawUsdArs;
      }
      if (paymentMethod) {
        options.forcedPaymentMethod = paymentMethod;
      }
      if (paymentMethod === 'tarjeta') {
        options.forcedCardId = cardId;
      }
      if (allowCashInstallment === true) {
        options.allowCashInstallment = true;
      }
      if (rawInstallmentImpact === 'closed_statement' || rawInstallmentImpact === 'next_statement') {
        options.installmentStatementImpact = rawInstallmentImpact;
      }
      const result = await this.processChat.execute(message, options);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
