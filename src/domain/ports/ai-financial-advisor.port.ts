export type AdvisorContext = {
  intent: string;
  user_message: string;
  data: unknown;
};

export type AdvisorAnswer = {
  answer: string;
};

export interface AiFinancialAdvisorPort {
  answer(context: AdvisorContext): Promise<AdvisorAnswer>;
}

export const AI_FINANCIAL_ADVISOR = Symbol('AI_FINANCIAL_ADVISOR');
