import { Inject, Injectable } from '@nestjs/common';
import { SignatureScheme } from '../../generated/prisma/client';
import { APP_CONFIG } from '../../common/config/config.module';
import type { AppConfig } from '../../common/config/config';
import { GenericVerifier } from './generic.verifier';
import { GithubVerifier } from './github.verifier';
import { StripeVerifier } from './stripe.verifier';
import type { WebhookVerifier } from './webhook-verifier';

@Injectable()
export class VerifierRegistry {
  private readonly verifiers: Record<SignatureScheme, WebhookVerifier>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.verifiers = {
      [SignatureScheme.GITHUB]: new GithubVerifier(),
      [SignatureScheme.STRIPE]: new StripeVerifier(config.stripeToleranceSeconds),
      [SignatureScheme.GENERIC]: new GenericVerifier(),
    };
  }

  get(scheme: SignatureScheme): WebhookVerifier {
    return this.verifiers[scheme];
  }
}
