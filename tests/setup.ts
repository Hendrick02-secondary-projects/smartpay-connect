import "dotenv/config";

// Integration tests run against TEST_DATABASE_URL (never the development/production database).
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
process.env.SESSION_SECRET ??= "test-session-secret-test-session-secret-0123456789";
process.env.MOCK_WEBHOOK_SECRET ??= "test-mock-webhook-secret";
process.env.IP_HASH_SALT ??= "test-ip-salt";
process.env.APP_URL ??= "http://localhost:3000";
