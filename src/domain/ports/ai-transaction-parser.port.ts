import type { MedioPago, MovimientoTipo } from '../entities/ingreso-egreso.entity';
import type { TarjetaRow } from './tarjeta-repository.port';

export type ParsedTransaction =
  | {
      save: true;
      currency: string;
      amount: number | null;
      type: MovimientoTipo;
      detail: string;
      /** Pista para matchear contra public.categorias.nombre */
      categoriaNombre: string | null;
      medioPago: MedioPago;
      /** Pista para matchear contra public.tarjetas.name (y bank / payment_card) */
      tarjetaNombre: string | null;
      /** YYYY-MM-DD */
      movementDate: string;
      /** Cantidad total de cuotas si el mensaje lo indica (ej. 3 en "3 cuotas") */
      installmentsTotal?: number | null;
    }
  | {
      save: false;
      reason: string;
    };

export type ParseContext = {
  categorias: { id: string; nombre: string }[];
  tarjetas: TarjetaRow[];
};

export interface AiTransactionParserPort {
  parse(
    userMessage: string,
    context?: ParseContext,
  ): Promise<ParsedTransaction>;
}

export const AI_TRANSACTION_PARSER = Symbol('AI_TRANSACTION_PARSER');
