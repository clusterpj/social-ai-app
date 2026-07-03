import { webhookCallback } from "grammy";
import { bot } from "./bot";
import { config, VERSION } from "./config";
import { db, dbHealthy, isMediaPending } from "./db";
import { errorFields, log } from "./log";
import { cleanupOldMedia } from "./media";

const startedAt = Date.now();

const isLocal = config.PUBLIC_BASE_URL.includes("localhost") || config.PUBLIC_BASE_URL.includes("104.248.121.22");

const handleUpdate = isLocal ? null : webhookCallback(bot, "bun", {
  secretToken: config.TELEGRAM_WEBHOOK_SECRET,
});

// nanoid filenames + known image extensions only — no traversal, no dotfiles.
const MEDIA_NAME = /^[a-zA-Z0-9_-]+\.(jpg|png|webp)$/;

const server = Bun.serve({
  port: config.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/webhook") {
      if (!handleUpdate) return new Response("Webhooks disabled in local dev", { status: 403 });
      
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

    function checkAuth(request: Request) {
      const auth = request.headers.get("Authorization");
      if (!auth || !auth.startsWith("Basic ")) return false;
      const decoded = atob(auth.slice(6));
      return decoded === `admin:${config.ADMIN_PASSWORD}`;
    }

    if (url.pathname === "/admin") {
      if (!checkAuth(req)) {
        return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Admin"' } });
      }
      const file = Bun.file("public/admin.html");
      return new Response(file, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/api/settings") {
      if (!checkAuth(req)) {
        return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Admin"' } });
      }
      if (req.method === "GET") {
        const { getSettings } = await import("./db");
        return Response.json(getSettings());
      }
      if (req.method === "POST") {
        const body = await req.json();
        const { updateSettings } = await import("./db");
        updateSettings(body as any);
        return Response.json({ success: true });
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

bot.init().then(
  () => {
    log("info", "bot_initialized", { username: bot.botInfo.username });
    
    // Set the native Telegram command menu
    bot.api.setMyCommands([
      { command: "post", description: "Sube una foto y genera el texto (requiere foto)" },
      { command: "dream", description: "Genera una imagen y texto con IA (ej: /dream un gato)" },
      { command: "status", description: "Ver tus cuentas conectadas y límite diario" },
      { command: "help", description: "Ver instrucciones de uso" },
    ]).catch((err) => log("warn", "set_commands_failed", errorFields(err)));
    
    // If we're running locally, Telegram can't reach our webhook. Switch to polling!
    if (isLocal) {
      log("info", "local_dev_mode", { polling: true });
      // Temporarily commented out for local UI testing to prevent 409 conflict
      // bot.api.deleteWebhook().then(() => {
      //   bot.start({
      //     onStart: (botInfo) => log("info", "bot_polling_started", { username: botInfo.username }),
      //   });
      // });
    }
  },
  (err: unknown) => log("warn", "bot_init_failed", errorFields(err)),
);

// Daily media cleanup: remove files older than MEDIA_RETENTION_DAYS
// whose associated draft is no longer pending.
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const cleanupTimer = setInterval(() => {
  try {
    cleanupOldMedia(isMediaPending);
  } catch (err) {
    log("error", "media_cleanup_error", errorFields(err));
  }
}, CLEANUP_INTERVAL_MS);

// Run once at startup too (in case the server was down for a while).
try {
  cleanupOldMedia(isMediaPending);
} catch (err) {
  log("error", "media_cleanup_startup_error", errorFields(err));
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutdown_started", { signal });
  clearInterval(cleanupTimer);
  await server.stop(); // graceful: waits for in-flight requests
  
  if (isLocal) {
    await bot.stop();
  }
  
  db.close();
  log("info", "shutdown_complete", {});
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
