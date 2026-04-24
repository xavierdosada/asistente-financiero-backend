import { Injectable } from '@nestjs/common';
import {
  AdvisorAnswer,
  AdvisorContext,
  AiFinancialAdvisorPort,
} from '../../domain/ports/ai-financial-advisor.port';

/**
 * Prompt del chat "Asesor Financiero IA".
 * Reglas: jamás inventar datos y responder solo en base al contexto estructurado recibido.
 */
const ADVISOR_SYSTEM_PROMPT = `Sos un Asesor Financiero IA.
Tu tarea es responder preguntas financieras usando EXCLUSIVAMENTE el contexto de datos que te entregamos.

Reglas obligatorias:
1) No inventes montos, fechas ni entidades.
2) Si faltan datos, decilo explícitamente.
3) Respuesta en español rioplatense, clara y profesional.
4) Estructura fija:
   - Resumen
   - Datos utilizados
   - Qué significa
   - Próximos pasos
5) No devuelvas JSON, devolvé texto plano útil para chat.
6) Si el usuario pide algo fuera del contexto, explicá qué dato falta y cómo cargarlo.`;

type GeminiGenerateResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  error?: { message?: string; code?: number };
};

@Injectable()
export class GeminiFinancialAdvisorAdapter implements AiFinancialAdvisorPort {
  async answer(context: AdvisorContext): Promise<AdvisorAnswer> {
    const apiKey = process.env.G_GEMINI_API_KEY?.trim();
    if (!apiKey) throw new Error('Falta G_GEMINI_API_KEY');

    const model = process.env.GEMINI_MODEL?.trim() ?? 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const userPrompt = [
      `Intento detectado: ${context.intent}`,
      `Mensaje del usuario: ${context.user_message}`,
      'Contexto de datos (JSON):',
      JSON.stringify(context.data),
    ].join('\n\n');

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: ADVISOR_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.2,
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

    const text =
      body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')?.trim() ??
      '';

    if (!text) {
      const reason = body.candidates?.[0]?.finishReason;
      throw new Error(
        reason ? `Respuesta vacía de Gemini (finishReason: ${reason})` : 'Respuesta vacía de Gemini',
      );
    }

    return { answer: text };
  }
}
