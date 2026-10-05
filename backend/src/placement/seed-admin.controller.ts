import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { assertInternalSecret } from '../auth/internal-secret';
import { SeedListService } from './seed-list.service';

/**
 * Operator-only seed mailbox management (MR-14). Not reachable from the
 * browser (the frontend proxy refuses `/internal/*`); every call needs the
 * `X-Internal-Secret` header. Stored passwords are never returned.
 */
@Controller('internal/seeds')
export class SeedAdminController {
  constructor(private readonly seeds: SeedListService) {}

  /** All seeds with their health, plus coverage against the per-test targets. */
  @Public()
  @Get()
  async list(@Headers('x-internal-secret') secret: string | undefined) {
    assertInternalSecret(secret);
    return { coverage: await this.seeds.coverage(), seeds: await this.seeds.list() };
  }

  /** Add a seed: `{ email, provider: gmail|outlook|yahoo, imapHost, imapPort, imapUser?, imapPass }`. */
  @Public()
  @Post()
  @HttpCode(200)
  async add(
    @Headers('x-internal-secret') secret: string | undefined,
    @Body()
    body: {
      email?: string;
      provider?: string;
      imapHost?: string;
      imapPort?: number;
      imapUser?: string;
      imapPass?: string;
    },
  ) {
    assertInternalSecret(secret);
    try {
      return await this.seeds.add({
        email: String(body?.email ?? ''),
        provider: String(body?.provider ?? ''),
        imapHost: String(body?.imapHost ?? ''),
        imapPort: Number(body?.imapPort),
        imapUser: body?.imapUser,
        imapPass: String(body?.imapPass ?? ''),
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /** Run the health check for every active seed now. */
  @Public()
  @Post('check')
  @HttpCode(200)
  async check(@Headers('x-internal-secret') secret: string | undefined) {
    assertInternalSecret(secret);
    return this.seeds.checkAll();
  }

  @Public()
  @Post(':id/disable')
  @HttpCode(200)
  async disable(@Headers('x-internal-secret') secret: string | undefined, @Param('id') id: string) {
    assertInternalSecret(secret);
    const row = await this.seeds.disable(id);
    if (!row) throw new NotFoundException();
    return row;
  }
}
