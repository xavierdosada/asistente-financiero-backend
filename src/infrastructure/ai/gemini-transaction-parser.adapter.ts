import { Injectable } from '@nestjs/common';
import type { MedioPago, MovimientoTipo } from '../../domain/entities/ingreso-egreso.entity';
import {
  AiTransactionParserPort,
  ParseContext,
  ParsedTransaction,
} from '../../domain/ports/ai-transaction-parser.port';

/**
 * Prompt del chat de registro transaccional.
 * Este agente NO asesora: solo extrae datos para guardar un movimiento o rechazar con motivo.
 */
const SYSTEM_BASE = `Sos un extractor transaccional de movimientos de dinero a partir de mensajes en español (u otros idiomas breves).
Respondé SIEMPRE un único JSON válido, sin markdown ni texto fuera del JSON.

Reglas estrictas:
- No des consejos, explicaciones largas ni conversación social.
- Si no hay un movimiento claro para guardar, devolvé save=false con reason formal y accionable.
- Tu única salida válida es el JSON del contrato.

Campos cuando el mensaje describe un ingreso o gasto concreto (montos explícitos o implícitos razonables):
- save: true
- currency: código ISO 4217 en mayúsculas (ej: ARS, USD, EUR). Si no está claro, inferí la moneda más probable del contexto o usá ARS.
- amount: número positivo (sin símbolo de moneda). Si dice "mil pesos" → 1000.
  Regla de cuotas (CRÍTICA):
  - Si el texto menciona una cuota puntual/progreso (ej: "cuota 02/03", "cuota 2/3", "voy por la cuota 2", "cuota 2 de 3")
    y también trae un monto, ese monto representa el valor de ESA cuota actual. No lo dividas.
  - Solo dividí un total por la cantidad de cuotas cuando el mensaje indique claramente que el monto es TOTAL
    (ej: "total 13503,33 en 3 cuotas", "importe total 13503,33 financiado en 3 cuotas", "gasté en total 13503,33 en 3 cuotas")
    y NO haya indicación de cuota puntual/progreso.
  Excepción: en pagos de cuota de préstamo (ej: "pagué la cuota del préstamo galeno"), podés devolver amount=null para que el backend complete automáticamente la cuota vigente.
- type: "ingreso" si es dinero que entra (cobro, sueldo, venta, depósito) o "gasto" si sale (compra, factura, pago).
- detail: frase corta qué fue (ej: "supermercado", "alquiler marzo").
- categoria_nombre: nombre de categoría alineado con la lista de categorías registradas que te damos abajo (copiá el texto exacto si coincide). Si ninguna encaja bien pero el gasto es obvio, elegí la más cercana. Si la lista está vacía en el contexto, usá null (el backend fallará hasta que haya categorías).
- medio_pago: "efectivo" si pagó/cobró en cash o transferencia inmediata sin mencionar plástico; "tarjeta" si menciona tarjeta, crédito, débito, Visa, Mastercard, cuotas, posnet, contactless, etc.
- tarjeta_nombre: solo si medio_pago es "tarjeta": el campo "name" de la tarjeta tal como figura en la lista (ej. "VISA NARANJA (credito)"), o una descripción que combine bank, payment_card y type_card de la fila elegida. Si no hay lista o ninguna coincide pero fue con tarjeta, describí brevemente o null. Si medio_pago es "efectivo", debe ser null.
- movement_date: fecha en que ocurrió el movimiento, solo día, formato YYYY-MM-DD. Si el usuario dice "ayer", "el lunes", "el 15", etc., calculá la fecha usando la referencia de "hoy" que te damos abajo. Si no hay ninguna pista temporal, usá la fecha de "hoy" de la referencia.
- installments_total: entero > 1 SOLO si el mensaje indica compra en cuotas (ej. "en 3 cuotas"). Si no aplica, devolvé null.

Si el mensaje es saludo, pregunta general, chiste o no contiene un movimiento identificable:
- save: false
- reason: breve explicación en español.

Ejemplos (reemplazá HOY por la fecha de referencia):
Usuario: "Gasté 3500 en el súper en pesos en efectivo" → ...,"categoria_nombre":"<una de la lista, ej. Comida>","medio_pago":"efectivo","tarjeta_nombre":null,"movement_date":"HOY"
Usuario: "Me pagaron el freelance 200 usd ayer" → incluí movement_date y categoria_nombre coherente con la lista.
Usuario: "16/03/26 AUGUSTO C local de ropa Cuota 02/03 $ 13.503,33 tarjeta BBVA" → amount=13503.33, installments_total=3, detail corto (ej: "AUGUSTO C"), categoria_nombre coherente con ropa, medio_pago="tarjeta".
Usuario: "16/03/26 local de ropa llamado AUGUSTO C vamos por la Cuota 02/03 cada cuota fue de $ 13.503,33 tarjeta BBVA" → amount=13503.33, installments_total=3 (NO dividir).
Usuario: "Gasté en total 13503,33 en 3 cuotas con tarjeta" → amount=4501.11, installments_total=3 (división permitida por total explícito).
Usuario: "Hola cómo estás" → {"save":false,"reason":"No hay un ingreso ni gasto para registrar."}`;

type RawAi = {
  save?: boolean;
  reason?: string;
  currency?: string;
  amount?: unknown;
  type?: string;
  detail?: string;
  categoria_nombre?: string | null;
  /** compat con respuestas viejas */
  categoria?: string;
  medio_pago?: string;
  tarjeta_nombre?: string | null;
  movement_date?: string;
  installments_total?: unknown;
};

type GeminiGenerateResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  error?: { message?: string; code?: number };
};

@Injectable()
export class GeminiTransactionParserAdapter implements AiTransactionParserPort {
  async parse(
    userMessage: string,
    context?: ParseContext,
  ): Promise<ParsedTransaction> {
    const apiKey = process.env.G_GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('Falta G_GEMINI_API_KEY');
    }
    // gemini-2.0-flash ya no está disponible para cuentas nuevas; usar 2.5+ o definir GEMINI_MODEL.
    const model = process.env.GEMINI_MODEL?.trim() ?? 'gemini-2.5-flash';
    const todayIso = utcDateOnly(new Date());
    const categoriasHint =
      context?.categorias?.length ?
        `\nCategorías registradas (usá categoria_nombre igual o muy parecido a una de estas): ${context.categorias.map((c) => `"${c.nombre}"`).join(', ')}.`
      : '\nNo hay categorías registradas: devolvé save false con reason explicando que falta configuración.';
    const tarjetasHint =
      context?.tarjetas?.length ?
        `\nTarjetas registradas (para tarjeta_nombre preferí el "name" exacto de la fila): ${context.tarjetas.map((t) => `name="${t.name}" | bank=${t.bank} | payment_card=${t.payment_card} | type_card=${t.type_card}`).join(' · ')}.`
      : '\nNo hay tarjetas registradas aún; si medio_pago es tarjeta, tarjeta_nombre puede ser una descripción corta o null.';
    const systemText = `${SYSTEM_BASE}${categoriasHint}${tarjetasHint}\n\nReferencia temporal (UTC, día calendario): hoy es ${todayIso}.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemText }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: userMessage }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      }),
    });

    const rawText = await res.text();
    let body: GeminiGenerateResponse;
    try {
      body = JSON.parse(rawText) as GeminiGenerateResponse;
    } catch {
      body = {};
    }

    if (!res.ok) {
      const msg = body.error?.message ?? rawText;
      throw new Error(`Gemini HTTP ${res.status}: ${msg}`);
    }

    const content =
      body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ??
      '';
    if (!content.trim()) {
      const reason = body.candidates?.[0]?.finishReason;
      throw new Error(
        reason
          ? `Respuesta vacía de Gemini (finishReason: ${reason})`
          : 'Respuesta vacía de Gemini',
      );
    }

    const jsonText = extractJsonObject(content);
    let raw: RawAi;
    try {
      raw = JSON.parse(jsonText) as RawAi;
    } catch {
      throw new Error('JSON inválido de Gemini');
    }

    if (raw.save === false) {
      return {
        save: false,
        reason: typeof raw.reason === 'string' ? raw.reason : 'No aplicable.',
      };
    }

    if (raw.save !== true) {
      return { save: false, reason: 'No se pudo interpretar el mensaje.' };
    }

    const amount =
      typeof raw.amount === 'number'
        ? raw.amount
        : typeof raw.amount === 'string'
          ? Number.parseFloat(raw.amount)
          : NaN;

    const type = normalizeTipo(raw.type);
    const currency =
      typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
    const detail =
      typeof raw.detail === 'string' ? raw.detail.trim() : '';

    const movementDateRaw =
      typeof raw.movement_date === 'string' ? raw.movement_date.trim() : '';
    const movementDate =
      movementDateRaw && isIsoYmd(movementDateRaw)
        ? movementDateRaw
        : todayIso;

    const categoriaNombre = pickCategoriaNombre(raw);

    const medioPago = normalizeMedio(raw.medio_pago);

    let tarjetaNombre: string | null = null;
    if (raw.tarjeta_nombre != null && typeof raw.tarjeta_nombre === 'string') {
      const tn = raw.tarjeta_nombre.trim();
      tarjetaNombre = tn.length ? tn : null;
    }
    if (medioPago === 'efectivo') {
      tarjetaNombre = null;
    }

    if (!type || !currency || !detail) {
      return {
        save: false,
        reason: 'Faltan datos para registrar el movimiento.',
      };
    }

    if (!isIsoYmd(movementDate)) {
      return {
        save: false,
        reason: 'Fecha del movimiento inválida.',
      };
    }

    const installmentsTotalOut = normalizeInstallments(raw.installments_total);
    return {
      save: true,
      currency,
      amount: Number.isFinite(amount) ? amount : null,
      type,
      detail,
      categoriaNombre,
      medioPago,
      tarjetaNombre,
      movementDate,
      installmentsTotal: installmentsTotalOut,
    };
  }
}

/** Por si el modelo devuelve fences o texto alrededor del JSON. */
function extractJsonObject(s: string): string {
  const t = s.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t);
  if (fence) return fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}

function normalizeTipo(t: string | undefined): MovimientoTipo | null {
  if (!t || typeof t !== 'string') return null;
  const v = t.trim().toLowerCase();
  if (v === 'ingreso' || v === 'income') return 'ingreso';
  if (v === 'gasto' || v === 'expense' || v === 'egreso') return 'gasto';
  return null;
}

function normalizeMedio(m: string | undefined): MedioPago {
  if (m == null || typeof m !== 'string' || !m.trim()) return 'efectivo';
  const v = m.trim().toLowerCase();
  if (v === 'efectivo' || v === 'cash') return 'efectivo';
  if (
    v === 'tarjeta' ||
    v === 'card' ||
    v === 'credito' ||
    v === 'crédito' ||
    v === 'debito' ||
    v === 'débito'
  ) {
    return 'tarjeta';
  }
  return 'efectivo';
}

function pickCategoriaNombre(raw: RawAi): string | null {
  if (raw.categoria_nombre != null && typeof raw.categoria_nombre === 'string') {
    const t = raw.categoria_nombre.trim();
    if (t.length) return t;
  }
  if (typeof raw.categoria === 'string' && raw.categoria.trim()) {
    return raw.categoria.trim();
  }
  return null;
}

function utcDateOnly(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isIsoYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T12:00:00.000Z`);
  return !Number.isNaN(t);
}

function normalizeInstallments(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isInteger(n) || n <= 1 || n > 120) return null;
  return n;
}
