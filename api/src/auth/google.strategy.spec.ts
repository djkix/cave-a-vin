import { UnauthorizedException } from '@nestjs/common';
import { Profile } from 'passport-google-oauth20';
import { GoogleStrategy } from './google.strategy';

process.env.DATABASE_URL ??= 'postgresql://postgres:dev@localhost:5432/cave';
process.env.SESSION_SECRET ??= 'a'.repeat(32);

function profileWith(emails: Profile['emails'], json: Record<string, unknown> = {}): Profile {
  return { id: 'sub-1', displayName: 'Anne', emails, provider: 'google', _json: json } as unknown as Profile;
}

describe('GoogleStrategy.validate', () => {
  function setup() {
    const auth = { findOrCreateGoogleUser: jest.fn(async (p: unknown) => p) };
    return { auth, strategy: new GoogleStrategy(auth as any) };
  }

  it('passe une adresse vérifiée au service de comptes', async () => {
    const { auth, strategy } = setup();
    await strategy.validate('', '', profileWith([{ value: 'a@example.com', verified: true }], { email_verified: true }));
    expect(auth.findOrCreateGoogleUser).toHaveBeenCalledWith({ sub: 'sub-1', email: 'a@example.com', displayName: 'Anne' });
  });

  it('refuse une adresse que Google déclare non vérifiée (invitations et ADMIN_EMAILS ne doivent pas la reconnaître)', async () => {
    const { auth, strategy } = setup();
    await expect(strategy.validate('', '', profileWith([{ value: 'admin@example.com', verified: false }]))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      strategy.validate('', '', profileWith([{ value: 'admin@example.com' } as any], { email_verified: false })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.findOrCreateGoogleUser).not.toHaveBeenCalled();
  });

  it('refuse un profil sans adresse', async () => {
    const { auth, strategy } = setup();
    await expect(strategy.validate('', '', profileWith(undefined))).rejects.toThrow('Profil Google sans adresse e-mail');
    expect(auth.findOrCreateGoogleUser).not.toHaveBeenCalled();
  });
});
