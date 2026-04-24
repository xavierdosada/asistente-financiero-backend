import { Body, Controller, HttpException, HttpStatus, Post } from '@nestjs/common';
import {
  ProcessAdvisorMessageUseCase,
  type AdvisorRequest,
} from '../../application/process-advisor-message.use-case';
import { isEntryScope } from '../../domain/ports/entry-mode.port';

class AdvisorMessageDto {
  message!: string;
  card_id?: string;
  from?: string;
  to?: string;
  year?: number;
  month?: number;
  scope?: string;
}

@Controller('asesor')
export class AsesorController {
  constructor(private readonly processAdvisor: ProcessAdvisorMessageUseCase) {}

  @Post('messages')
  async postMessage(@Body() body: AdvisorMessageDto) {
    if (typeof body?.message !== 'string' || !body.message.trim()) {
      throw new HttpException('Campo "message" requerido', HttpStatus.BAD_REQUEST);
    }
    if (
      body.year !== undefined &&
      (!Number.isInteger(body.year) || body.year < 2000 || body.year > 2100)
    ) {
      throw new HttpException('Campo "year" inválido', HttpStatus.BAD_REQUEST);
    }
    if (
      body.month !== undefined &&
      (!Number.isInteger(body.month) || body.month < 1 || body.month > 12)
    ) {
      throw new HttpException('Campo "month" inválido', HttpStatus.BAD_REQUEST);
    }
    if (body.from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.from)) {
      throw new HttpException('Campo "from" inválido (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
    }
    if (body.to !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.to)) {
      throw new HttpException('Campo "to" inválido (YYYY-MM-DD)', HttpStatus.BAD_REQUEST);
    }
    if (
      body.scope !== undefined &&
      (typeof body.scope !== 'string' || !isEntryScope(body.scope))
    ) {
      throw new HttpException(
        'Campo "scope" inválido: use operativo, historico o ambos',
        HttpStatus.BAD_REQUEST,
      );
    }

    const req: AdvisorRequest = {
      message: body.message,
      card_id: body.card_id,
      from: body.from,
      to: body.to,
      year: body.year,
      month: body.month,
      scope: body.scope ?? 'ambos',
    };

    try {
      return await this.processAdvisor.execute(req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error interno';
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
