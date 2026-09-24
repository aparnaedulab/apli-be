import { createApp } from './app.js';
import { env } from './config/env.js';
import { disconnectPrisma, prisma } from './lib/prisma.js';
import { startWhatsAppDispatcher, stopWhatsAppDispatcher } from './modules/whatsapp/dispatcher.js';

async function main(): Promise<void> {
  // Fail loudly at boot rather than on the first request.
  await prisma.$connect();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`apli-server listening on http://localhost:${env.PORT}`);
    console.log(`  environment : ${env.NODE_ENV}`);
    console.log(`  client       : ${env.CLIENT_ORIGIN}`);
    console.log(`  health       : http://localhost:${env.PORT}/api/health`);
  });

  // Copies important notifications to WhatsApp once a minute. It sends
  // nothing until the Cloud API is configured - see modules/whatsapp.
  if (env.NODE_ENV !== 'test') startWhatsAppDispatcher();

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down.`);
    stopWhatsAppDispatcher();
    server.close(async () => {
      await disconnectPrisma();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async (err) => {
  console.error('Failed to start server:', err);
  await disconnectPrisma();
  process.exit(1);
});
