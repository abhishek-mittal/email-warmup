import { Injectable, Logger } from '@nestjs/common';
import * as dns from 'dns';
import { RBL_LIST } from './rbl-list';

export type RblStatus = 'clean' | 'listed' | 'unknown';

export interface BlacklistCheckResult {
  isClean: boolean;
  listed: string[];
  listedCount: number;
  rblResults: Record<string, RblStatus>;
}

const RBL_TIMEOUT_MS = 5_000;

// NXDOMAIN-equivalent codes from Node's dns module — see T012 context addendum #6.
const NXDOMAIN_CODES = new Set(['ENOTFOUND', 'ENODATA']);

@Injectable()
export class BlacklistService {
  private readonly logger = new Logger(BlacklistService.name);

  /**
   * Checks `domain` against every RBL in RBL_LIST in parallel. Each lookup is
   * independently raced against a 5s timeout so one slow/erroring RBL never blocks
   * the others (Promise.allSettled over all zones).
   */
  async checkDomain(domain: string): Promise<BlacklistCheckResult> {
    const outcomes = await Promise.allSettled(
      RBL_LIST.map((rblZone) => this.checkSingleRbl(domain, rblZone)),
    );

    const rblResults: Record<string, RblStatus> = {};
    const listed: string[] = [];

    outcomes.forEach((outcome, index) => {
      const rblZone = RBL_LIST[index];
      // checkSingleRbl never rejects (all errors are caught internally), but guard
      // defensively in case Promise.allSettled ever sees a rejection.
      const status: RblStatus = outcome.status === 'fulfilled' ? outcome.value : 'unknown';
      rblResults[rblZone] = status;
      if (status === 'listed') {
        listed.push(rblZone);
      }
    });

    return {
      isClean: listed.length === 0,
      listed,
      listedCount: listed.length,
      rblResults,
    };
  }

  private async checkSingleRbl(domain: string, rblZone: string): Promise<RblStatus> {
    const query = `${domain}.${rblZone}`;

    try {
      const addresses = await this.withTimeout(dns.promises.resolve4(query), RBL_TIMEOUT_MS);
      return addresses.some((address) => address.startsWith('127.')) ? 'listed' : 'clean';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code && NXDOMAIN_CODES.has(code)) {
        return 'clean';
      }

      this.logger.warn(`RBL lookup failed for ${query}: ${(error as Error)?.message ?? error}`);
      return 'unknown';
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RBL lookup timed out')), timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}
