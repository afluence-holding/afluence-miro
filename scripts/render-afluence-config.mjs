import { writeFileSync } from 'node:fs';

const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const output = process.env.AFLUENCE_CONFIG_PATH || '/app/config.json';
const config = {
  server: { name: 'Afluence Miro' },
  oauth: {
    'providers.oidc': {
      clientId: required('AFLUENCE_OIDC_CLIENT_ID'),
      clientSecret: required('AFLUENCE_OIDC_CLIENT_SECRET'),
      issuer: required('AFLUENCE_OIDC_ISSUER').replace(/\/$/, ''),
      args: {
        scope: 'openid profile email',
        claim_id: 'sub',
        claim_email: 'email',
        claim_name: 'name',
        claim_email_verified: 'email_verified',
      },
    },
  },
};

writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Afluence runtime configuration written to ${output}`);
