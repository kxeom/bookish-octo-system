import app from "./app";
import { logger } from "./lib/logger";
import bot from "./bot/bot";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Start Telegram bot with retry logic
async function launchBot(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      logger.info("Telegram bot started successfully");
      return;
    } catch (err: any) {
      if (err?.response?.error_code === 409) {
        // Conflict: another instance running - wait and retry
        logger.warn({ attempt: i + 1 }, "Bot conflict (409), retrying in 3s...");
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        logger.error({ err }, "Failed to start Telegram bot");
        return;
      }
    }
  }
  logger.error("Bot failed to start after max retries");
}

launchBot();

// Graceful shutdown
process.once("SIGINT", () => {
  logger.info("SIGINT received, shutting down bot");
  bot.stop("SIGINT");
});
process.once("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down bot");
  bot.stop("SIGTERM");
});
