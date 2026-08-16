import { writeFileSync } from 'node:fs';

const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const positiveInteger = (name, fallback) => {
  const value = process.env[name]?.trim();
  if (!value) return fallback;

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  return Number(value);
};

const withPrismaConnectionLimit = (databaseUrl, connectionLimit) => {
  const url = new URL(databaseUrl);
  url.searchParams.set('connection_limit', String(connectionLimit));
  return url.toString();
};

const output = process.env.AFLUENCE_CONFIG_PATH || '/app/config.json';
writeFileSync(
  output,
  `${JSON.stringify(
    {
      server: { name: 'Afluence Miro' },
      db: {
        prisma: {
          datasources: {
            db: {
              url: withPrismaConnectionLimit(
                required('DATABASE_URL'),
                positiveInteger('AFLUENCE_PRISMA_CONNECTION_LIMIT', 3)
              ),
            },
          },
        },
      },
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
