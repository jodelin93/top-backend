import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Permission } from '../auth/permissions';

/**
 * JodaPrint (the print agent installed on the till computer): the POS page asks
 * this server to sign each request it sends to the agent, so only signed-in store
 * staff can print or open the drawer through it. The private key never leaves
 * the server (JODAPRINT_SIGNING_KEY).
 */
export interface JodaPrintSignPayload {
  method: string;
  orgId?: string;
  params?: Record<string, unknown>;
}

export interface JodaPrintSignature {
  keyId: string;
  sig: string;
  ts: number;
  nonce: string;
}

type Signer = (payload: {
  method: string;
  orgId?: string;
  params?: unknown;
}) => Promise<JodaPrintSignature>;

// What the POS uses: receipts, printer list and status, job follow-up, the drawer
export const JODAPRINT_METHODS = [
  'printers.list',
  'printers.status',
  'print',
  'jobs.get',
  'jobs.cancel',
  'drawer.open',
  'subscribe',
] as const;

// Opening the drawer: till staff and those who set the hardware up
const DRAWER_PERMISSIONS: Permission[] = ['pos.sell', 'hardware.manage'];

@Injectable()
export class JodaPrintService {
  private signer: Promise<Signer> | null = null;

  constructor(private config: ConfigService) {}

  private settings() {
    const orgId = this.config.get<string>('JODAPRINT_ORG_ID')?.trim() || null;
    const keyId = this.config.get<string>('JODAPRINT_KEY_ID')?.trim() || null;
    // A PEM pasted into one variable keeps its line breaks as "\n"
    const privateKey =
      this.config
        .get<string>('JODAPRINT_SIGNING_KEY')
        ?.replace(/\\n/g, '\n')
        .trim() || null;
    // The stores this JodaPrint organization belongs to (comma-separated ids).
    // Its signatures name no store or till: any agent of the organization
    // accepts them, so only these stores may get them. Empty: every store (one
    // business per server)
    const tenantIds = (this.config.get<string>('JODAPRINT_TENANT_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    return { orgId, keyId, privateKey, tenantIds };
  }

  /** What the POS page needs to talk to the agent (no secret) */
  publicConfig(tenantId?: string | null): {
    enabled: boolean;
    orgId: string | null;
  } {
    const { orgId, keyId, privateKey, tenantIds } = this.settings();
    const enabled =
      !!(orgId && keyId && privateKey) &&
      (!tenantIds.length || (!!tenantId && tenantIds.includes(tenantId)));
    return { enabled, orgId: enabled ? orgId : null };
  }

  async sign(
    payload: JodaPrintSignPayload,
    permissions: readonly Permission[],
    tenantId?: string | null,
  ): Promise<JodaPrintSignature> {
    const { orgId } = this.settings();
    if (!this.publicConfig(tenantId).enabled || !orgId) {
      throw new NotFoundException('JodaPrint is not set up on this server');
    }
    if (!(JODAPRINT_METHODS as readonly string[]).includes(payload.method)) {
      throw new ForbiddenException(`${payload.method} is not signed here`);
    }
    // Never sign for another organization's printers
    if (payload.orgId !== undefined && payload.orgId !== orgId) {
      throw new BadRequestException('Unknown JodaPrint organization');
    }
    if (
      payload.method === 'drawer.open' &&
      !DRAWER_PERMISSIONS.some((p) => permissions.includes(p))
    ) {
      throw new ForbiddenException('You may not open the cash drawer');
    }
    const signer = await this.loadSigner();
    return signer({
      method: payload.method,
      orgId,
      params: payload.params ?? {},
    });
  }

  /** The Ed25519 signer of @jodaprint/node (an ES module: loaded on first use) */
  protected loadSigner(): Promise<Signer> {
    if (!this.signer) {
      const { orgId, keyId, privateKey } = this.settings();
      this.signer = import('@jodaprint/node')
        .then(({ createSigner }) =>
          createSigner({
            orgId: orgId!,
            keyId: keyId!,
            privateKey: privateKey!,
          }),
        )
        .catch((error) => {
          this.signer = null;
          throw error;
        });
    }
    return this.signer;
  }
}
