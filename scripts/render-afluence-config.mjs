import { writeFileSync } from 'node:fs';

const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const output = process.env.AFLUENCE_CONFIG_PATH || '/app/config.json';
writeFileSync(
  output,
  `${JSON.stringify(
    {
      server: { name: 'Afluence Miro' },
      oauth: {
        'providers.oidc': {
          clientId: required('AFLUENCE_OIDC_CLIENT_ID'),
          clientSecret: required('AFLUENCE_OIDC_CLIENT_SECRET'),
          issuer: required('AFLUENCE_OIDC_ISSUER').replace(/\/$/, ''),
          args: { scope: 'openid profile email' },
        },
      },
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
);
console.log(`Afluence runtime configuration written to ${output}`);
