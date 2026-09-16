// Prints n8n credentials JSON built from environment variables.
// Runs inside a throwaway n8n container (see setup.sh); n8n encrypts the data on import.
// IDs must match builder/lib.mjs CREDENTIALS.
const required = (key, fallback) => {
  const value = process.env[key] || fallback;
  if (!value) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
  return value;
};

const credentials = [
  {
    id: 'smPostgresCred01',
    name: 'SM App Postgres',
    type: 'postgres',
    data: {
      host: required('DB_POSTGRESDB_HOST'),
      port: 5432,
      database: required('APP_DB_NAME', 'smapp'),
      user: required('DB_POSTGRESDB_USER'),
      password: required('DB_POSTGRESDB_PASSWORD'),
      ssl: 'disable',
      allowUnauthorizedCerts: false,
      sshTunnel: false,
    },
  },
  {
    id: 'smTelegramCred01',
    name: 'SM Telegram Bot',
    type: 'telegramApi',
    data: { accessToken: required('TELEGRAM_BOT_TOKEN'), baseUrl: 'https://api.telegram.org' },
  },
  {
    id: 'smGeminiKey01',
    name: 'SM Gemini API Key',
    type: 'httpHeaderAuth',
    data: { name: 'x-goog-api-key', value: required('GEMINI_API_KEY') },
  },
  {
    id: 'smS3Storage00001',
    name: 'SM Media Storage',
    type: 's3',
    data: {
      endpoint: required('S3_ENDPOINT', 'http://localhost:9000'),
      region: required('S3_REGION', 'auto'),
      accessKeyId: required('S3_ACCESS_KEY_ID', 'test'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY', 'test'),
      forcePathStyle: true,
      ignoreSSLIssues: false,
    },
  },
];

process.stdout.write(JSON.stringify(credentials, null, 2));
