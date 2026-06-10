import { webhookCallback } from "grammy";
import { bot } from "./bot";
import { config, VERSION } from "./config";
import { db, dbHealthy } from "./db";
import { errorFields, log } from "./log";

const startedAt = Date.now();

const handleUpdate = webhookCallback(bot, "bun", {
  secretToken: config.TELEGRAM_WEBHOOK_SECRET,
});

// nanoid filenames + known image extensions only — no traversal, no dotfiles.
const MEDIA_NAME = /^[a-zA-Z0-9_-]+\.(jpg|png|webp)$/;

const server = Bun.serve({
  port: config.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/webhook") {
      const t0 = performance.now();
      try {
        return await handleUpdate(req);
      } catch (err) {
        // Respond 200 so Telegram does not redeliver a poison update forever.
        log("error", "webhook_error", errorFields(err));
        return new Response("ok");
      } finally {
        log("info", "webhook_handled", {
          latency_ms: Math.round(performance.now() - t0),
        });
      }
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        db: dbHealthy() ? "ok" : "error",
        version: VERSION,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      const name = url.pathname.slice("/media/".length);
      if (!MEDIA_NAME.test(name)) return new Response("Not found", { status: 404 });
      const file = Bun.file(`data/media/${name}`);
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file, {
        headers: { "Cache-Control": "public, max-age=86400" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

log("info", "server_started", { port: config.PORT, version: VERSION });

// Fetch bot identity eagerly so /status and logs have it; webhookCallback
// initializes lazily anyway, so a transient failure here is non-fatal.
bot.init().then(
  () => log("info", "bot_initialized", { username: bot.botInfo.username }),
  (err: unknown) => log("warn", "bot_init_failed", errorFields(err)),
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutdown_started", { signal });
  await server.stop(); // graceful: waits for in-flight requests
  db.close();
  log("info", "shutdown_complete", {});
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
