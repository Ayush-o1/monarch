import app from './app.js';
import config from './config.js';

const server = app.listen(config.port, () => {
  console.log(
    `Handover server listening on port ${config.port} (${config.nodeEnv})`
  );
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
