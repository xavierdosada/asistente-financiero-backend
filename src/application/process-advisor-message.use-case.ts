import { Inject, Injectable } from '@nestjs/common';
import {
  ACCOUNT_REPOSITORY,
  AccountRepositoryPort,
} from '../domain/ports/account-repository.port';
import {
  AdvisorAnswer,
  AI_FINANCIAL_ADVISOR,
  AiFinancialAdvisorPort,
} from '../domain/ports/ai-financial-advisor.port';
import {
  LOAN_REPOSITORY,
  LoanRepositoryPort,
} from '../domain/ports/loan-repository.port';
import {
  TARJETA_REPOSITORY,
  TarjetaRepositoryPort,
  TarjetaRow,
} from '../domain/ports/tarjeta-repository.port';
import type { EntryScope } from '../domain/ports/entry-mode.port';

type AdvisorIntent =
  | 'loans_status'
  | 'card_spending'
  | 'card_debt_status'
  | 'cash_status'
  | 'general';

export type AdvisorRequest = {
  message: string;
  card_id?: string;
  from?: string;
  to?: string;
  year?: number;
  month?: number;
  scope?: EntryScope;
};

export type AdvisorResponse = {
  intent: AdvisorIntent;
  answer: string;
  data: unknown;
};

@Injectable()
export class ProcessAdvisorMessageUseCase {
  constructor(
    @Inject(AI_FINANCIAL_ADVISOR)
    private readonly advisor: AiFinancialAdvisorPort,
    @Inject(TARJETA_REPOSITORY)
    private readonly tarjetas: TarjetaRepositoryPort,
    @Inject(LOAN_REPOSITORY)
    private readonly loans: LoanRepositoryPort,
    @Inject(ACCOUNT_REPOSITORY)
    private readonly accounts: AccountRepositoryPort,
  ) {}

  async execute(input: AdvisorRequest): Promise<AdvisorResponse> {
    const message = input.message.trim();
    if (!message) {
      return {
        intent: 'general',
        answer: 'Necesito un mensaje para poder ayudarte con el análisis financiero.',
        data: {},
      };
    }

    const intent = detectIntent(message);
    const data = await this.fetchIntentData(intent, input);

    const ai: AdvisorAnswer = await this.advisor.answer({
      intent,
      user_message: message,
      data,
    });

    return {
      intent,
      answer: ai.answer,
      data,
    };
  }

  private async fetchIntentData(
    intent: AdvisorIntent,
    input: AdvisorRequest,
  ): Promise<unknown> {
    const scope: EntryScope = input.scope ?? 'ambos';

    if (intent === 'loans_status') {
      if (scope === 'historico') {
        return {
          scope,
          prestamos: [],
          note: 'Scope histórico no incluye datos operativos de préstamos.',
        };
      }
      const rows = await this.loans.list();
      return { scope, prestamos: rows };
    }

    if (intent === 'cash_status') {
      const now = new Date();
      const year = input.year ?? now.getUTCFullYear();
      const month = input.month ?? now.getUTCMonth() + 1;
      const resumen = await this.accounts.monthlyCashSummary(year, month, scope);
      return { scope, caja: resumen };
    }

    if (intent === 'card_spending' || intent === 'card_debt_status') {
      const cards = await this.tarjetas.list();
      const selectedCard = resolveCard(input.card_id, input.message, cards);

      if (!selectedCard) {
        return {
          error:
            'No pude identificar la tarjeta. Pasá card_id o mencioná banco/red exacta en el mensaje.',
          tarjetas_disponibles: cards.map((c) => ({
            id: c.id,
            name: c.name,
            bank: c.bank,
            payment_card: c.payment_card,
          })),
        };
      }

      if (intent === 'card_spending') {
        const range = defaultRange(input.from, input.to);
        const gastos = await this.tarjetas.spendByRange(
          selectedCard.id,
          range.from,
          range.to,
          scope,
        );
        const resumen = await this.tarjetas.usageSummaryById(
          selectedCard.id,
          new Date(),
          scope,
        );
        return {
          scope,
          tarjeta: selectedCard,
          rango: range,
          gastos,
          resumen_mes: resumen,
        };
      }

      if (scope === 'historico') {
        return {
          scope,
          tarjeta: selectedCard,
          note: 'Scope histórico no incluye deudas ni resúmenes operativos de tarjeta.',
          resumenes: [],
          deudas: [],
        };
      }

      const [resumenes, deudas] = await Promise.all([
        this.tarjetas.listStatementsByCardId(selectedCard.id),
        this.tarjetas.debtsByCardId(selectedCard.id),
      ]);
      return {
        scope,
        tarjeta: selectedCard,
        resumenes,
        deudas,
      };
    }

    if (scope === 'historico') {
      const tarjetas = await this.tarjetas.list();
      const range = defaultRange(input.from, input.to);
      const gastos_tarjetas = await Promise.all(
        tarjetas.map(async (t) => ({
          tarjeta: {
            id: t.id,
            name: t.name,
            bank: t.bank,
            payment_card: t.payment_card,
          },
          gastos: await this.tarjetas.spendByRange(t.id, range.from, range.to, 'historico'),
        })),
      );
      return {
        scope,
        tarjetas,
        gastos_tarjetas,
        prestamos: [],
        caja: null,
        note: 'Scope histórico evita mezclar datos operativos de préstamos/caja/deudas.',
      };
    }

    const [prestamos, tarjetas, caja_ars, caja_usd] = await Promise.all([
      this.loans.list(),
      this.tarjetas.list(),
      this.accounts.monthlyCashSummary(
        input.year ?? new Date().getUTCFullYear(),
        input.month ?? new Date().getUTCMonth() + 1,
        scope,
        'ARS',
      ),
      this.accounts.monthlyCashSummary(
        input.year ?? new Date().getUTCFullYear(),
        input.month ?? new Date().getUTCMonth() + 1,
        scope,
        'USD',
      ),
    ]);

    const tarjetas_estado = await Promise.all(
      tarjetas.map(async (t) => {
        const [deudas, resumenes] = await Promise.all([
          this.tarjetas.debtsByCardId(t.id),
          this.tarjetas.listStatementsByCardId(t.id),
        ]);
        return {
          tarjeta: {
            id: t.id,
            name: t.name,
            bank: t.bank,
            payment_card: t.payment_card,
          },
          deudas: deudas ?? [],
          resumenes: (resumenes ?? []).slice(0, 3),
        };
      }),
    );

    return {
      scope,
      prestamos,
      tarjetas,
      tarjetas_estado,
      caja: {
        ars: caja_ars,
        usd: caja_usd,
      },
    };
  }
}

function detectIntent(message: string): AdvisorIntent {
  const m = normalize(message);
  if (/\b(prestamo|prestamos|cuota del prestamo|deuda prestamo|estado del prestamo|estado prestamos)\b/.test(m)) {
    return 'loans_status';
  }
  if (/\b(caja|efectivo|saldo de caja|flujo de caja|como vengo de caja|estado de caja)\b/.test(m)) {
    return 'cash_status';
  }
  if (/\b(gaste|gastando|gastos|consumos|consumo|cuanto llevo gastado|gasto de tarjeta)\b/.test(m) && /\b(tarjeta|visa|mastercard|credito|debito)\b/.test(m)) {
    return 'card_spending';
  }
  if (/\b(deuda tarjeta|deudas de tarjeta|deuda de tarjetas|resumen|debo en la tarjeta|saldo tarjeta|estado de tarjetas)\b/.test(m)) {
    return 'card_debt_status';
  }
  return 'general';
}

function resolveCard(
  cardId: string | undefined,
  message: string,
  cards: TarjetaRow[],
): TarjetaRow | null {
  if (cardId) {
    const byId = cards.find((c) => c.id === cardId);
    if (byId) return byId;
  }

  const m = normalize(message);
  if (!m) return cards.length === 1 ? cards[0] : null;

  const score = (card: TarjetaRow): number => {
    const keys = [card.name, card.bank, card.payment_card].map(normalize);
    let s = 0;
    for (const k of keys) {
      if (!k) continue;
      if (m.includes(k)) s += 10;
      if (k.includes(m)) s += 3;
    }
    return s;
  };

  let best: TarjetaRow | null = null;
  let bestScore = 0;
  for (const card of cards) {
    const s = score(card);
    if (s > bestScore) {
      best = card;
      bestScore = s;
    }
  }

  if (best && bestScore > 0) return best;
  return cards.length === 1 ? cards[0] : null;
}

function defaultRange(
  from?: string,
  to?: string,
): { from: string; to: string } {
  if (from && to) return { from, to };
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: toIsoDate(start), to: toIsoDate(end) };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}
