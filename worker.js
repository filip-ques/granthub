import { Container, getContainer } from '@cloudflare/containers';

export class GranthubContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';

  constructor(ctx, env) {
    super(ctx, env);
    // Secrets Workera (wrangler secret put ...) sa prenesú do kontajnera ako env premenné
    this.envVars = {
      DATABASE_URL: env.DATABASE_URL,
      DATABASE_SSL: env.DATABASE_SSL || '1',
      SESSION_SECRET: env.SESSION_SECRET,
      SMTP_HOST: env.SMTP_HOST,
      SMTP_PORT: env.SMTP_PORT || '587',
      SMTP_SECURE: env.SMTP_SECURE || '0',
      SMTP_USER: env.SMTP_USER,
      SMTP_PASS: env.SMTP_PASS,
      MAIL_FROM: env.MAIL_FROM,
      ORDERS_EMAIL: env.ORDERS_EMAIL || '',
      CRON_SECRET: env.CRON_SECRET,
      ADMIN_EMAILS: env.ADMIN_EMAILS || 'filip@ques.sk',
      BASE_URL: env.BASE_URL,
      NODE_ENV: 'production',
    };
  }
}

export default {
  async fetch(request, env) {
    return getContainer(env.GRANTHUB_CONTAINER).fetch(request);
  },

  // Cron Triggers (wrangler.jsonc -> triggers.crons): kontajner nemá vlastný
  // plánovač, joby spúšťa Worker cez zabezpečené /cron/* endpointy.
  async scheduled(event, env, ctx) {
    const container = getContainer(env.GRANTHUB_CONTAINER);
    const call = (path) =>
      container.fetch(new Request(`https://cron.internal${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.CRON_SECRET}` },
      }));
    // ingest najprv, potom radar — nové výzvy odídu odberateľom v tom istom behu
    ctx.waitUntil((async () => { await call('/cron/ingest'); await call('/cron/tendre'); await call('/cron/radar'); })());
  },
};
