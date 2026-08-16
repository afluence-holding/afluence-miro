import { timingSafeEqual } from 'node:crypto';

import { Body, Controller, Delete, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';

import { ActionForbidden } from '../../base';
import { Models } from '../../models';
import { validators } from '../utils/validators';
import { Public } from './guard';
import { AuthService } from './service';

type LifecycleBody = {
  active?: boolean;
  name?: string;
};

@Public()
@Controller('/api/internal/afluence/users')
export class AfluenceLifecycleController {
  constructor(
    private readonly auth: AuthService,
    private readonly models: Models
  ) {}

  @Put('/:email')
  async sync(
    @Req() req: Request,
    @Param('email') emailParam: string,
    @Body() body: LifecycleBody
  ) {
    this.assertAuthorized(req);

    const email = emailParam.trim().toLowerCase();
    validators.assertValidEmail(email);
    const name = body.name?.trim() || email.split('@')[0];
    const active = body.active !== false;
    const existing = await this.models.user.getUserByEmail(email, {
      withDisabled: true,
    });

    if (!existing && !active) {
      return { ok: true, status: 'absent' };
    }

    const user = existing
      ? await this.models.user.update(existing.id, {
          name,
          disabled: !active,
        })
      : await this.models.user.create({
          email,
          name,
          registered: true,
          emailVerifiedAt: new Date(),
        });

    if (!active) {
      await this.auth.revokeUserSessions(user.id, 'afluence_access_revoked');
    }

    return {
      ok: true,
      status: existing ? (active ? 'enabled' : 'disabled') : 'created',
      userId: user.id,
    };
  }

  @Delete('/:email')
  async disable(@Req() req: Request, @Param('email') emailParam: string) {
    return this.sync(req, emailParam, { active: false });
  }

  private assertAuthorized(req: Request) {
    const configured = process.env.AFLUENCE_LIFECYCLE_SECRET?.trim();
    const provided = req.get('x-afluence-lifecycle-secret')?.trim();

    if (!configured || !provided) {
      throw new ActionForbidden();
    }

    const configuredBuffer = Buffer.from(configured);
    const providedBuffer = Buffer.from(provided);
    if (
      configuredBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(configuredBuffer, providedBuffer)
    ) {
      throw new ActionForbidden();
    }
  }
}
