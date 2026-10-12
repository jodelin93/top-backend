import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Permission } from '../auth/permissions';
import { JodaPrintService } from './jodaprint.service';

const signature = { keyId: 'sk_test', sig: 'abc', ts: 1, nonce: 'n' };

// The real signer is an ES module loaded on first use: tests replace it
class TestService extends JodaPrintService {
  readonly fake = jest.fn().mockResolvedValue(signature);
  protected loadSigner() {
    return Promise.resolve(this.fake);
  }
}

const service = (env: Record<string, string>) =>
  new TestService({ get: (key: string) => env[key] } as ConfigService);

const CONFIGURED = {
  JODAPRINT_ORG_ID: 'org_1',
  JODAPRINT_KEY_ID: 'sk_test',
  JODAPRINT_SIGNING_KEY: 'key',
};
const cashier: Permission[] = ['pos.sell'];

describe('JodaPrintService', () => {
  it('is off until the organization, key id and signing key are all set', async () => {
    const off = service({ JODAPRINT_ORG_ID: 'org_1' });
    expect(off.publicConfig()).toEqual({ enabled: false, orgId: null });
    await expect(off.sign({ method: 'print' }, cashier)).rejects.toThrow(
      NotFoundException,
    );
    expect(service(CONFIGURED).publicConfig()).toEqual({
      enabled: true,
      orgId: 'org_1',
    });
  });

  it('signs a print request for its own organization', async () => {
    const s = service(CONFIGURED);
    const params = { type: 'escpos', data: 'AA==' };
    await expect(
      s.sign({ method: 'print', orgId: 'org_1', params }, []),
    ).resolves.toEqual(signature);
    expect(s.fake).toHaveBeenCalledWith({
      method: 'print',
      orgId: 'org_1',
      params,
    });
  });

  it('refuses other organizations and methods it does not know', async () => {
    const s = service(CONFIGURED);
    await expect(
      s.sign({ method: 'print', orgId: 'org_other' }, cashier),
    ).rejects.toThrow(BadRequestException);
    await expect(s.sign({ method: 'agent.update' }, cashier)).rejects.toThrow(
      ForbiddenException,
    );
    expect(s.fake).not.toHaveBeenCalled();
  });

  it('opens the drawer only for till or hardware staff', async () => {
    const s = service(CONFIGURED);
    await expect(
      s.sign({ method: 'drawer.open' }, ['reports.view']),
    ).rejects.toThrow(ForbiddenException);
    await expect(s.sign({ method: 'drawer.open' }, cashier)).resolves.toEqual(
      signature,
    );
    await expect(
      s.sign({ method: 'drawer.open' }, ['hardware.manage']),
    ).resolves.toEqual(signature);
  });
});
