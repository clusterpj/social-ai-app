/**
 * Smoke test for bot commands and middleware:
 * Verifies that /help and /status commands route correctly,
 * and that the allowlist middleware blocks unauthorized chat IDs,
 * using an API transformer to mock Telegram API calls.
 * 
 * Usage: bun run scripts/smoke-commands.ts
 */
import { bot } from "../src/bot";
import { db } from "../src/db";
import { config } from "../src/config";

const ALLOWED_ID = config.ALLOWED_CHAT_IDS[0]!;

// Mock botInfo eagerly so handling updates does not invoke bot.init() API call
bot.botInfo = {
  id: 123456,
  is_bot: true,
  first_name: "smoke",
  username: "smoke_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  can_manage_bots: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  supports_join_request_queries: false,
} as any;

// Store intercepted API calls for assertion
const apiCalls: Array<{ method: string; payload: any }> = [];

// Intercept all outgoing Telegram API calls
bot.api.config.use(async (prev, method, payload, signal) => {
  apiCalls.push({ method, payload });
  
  // Return mock responses for different API methods
  if (method === "sendMessage") {
    return {
      ok: true,
      result: {
        message_id: 999,
        chat: (payload as any).chat_id,
        date: Math.floor(Date.now() / 1000),
        text: (payload as any).text,
      },
    };
  }
  return { ok: true, result: {} as any };
});

// Helper to simulate an update sent to the webhook
async function simulateUpdate(update: any) {
  apiCalls.length = 0; // Clear history
  await bot.handleUpdate(update);
  return [...apiCalls];
}

// 1. Test Allowlisted User - /help command
console.log("Testing allowlisted user sending /help...");
const helpCalls = await simulateUpdate({
  update_id: 10001,
  message: {
    message_id: 101,
    from: { id: ALLOWED_ID, is_bot: false, first_name: "Pedro" },
    chat: { id: ALLOWED_ID, type: "private", first_name: "Pedro" },
    date: Math.floor(Date.now() / 1000),
    text: "/help",
    entities: [{ offset: 0, length: 5, type: "bot_command" }],
  },
});

const helpPassed = helpCalls.length === 1 && 
  helpCalls[0]!.method === "sendMessage" && 
  helpCalls[0]!.payload.chat_id === ALLOWED_ID &&
  helpCalls[0]!.payload.text.includes("Social Command Center");

console.log(helpPassed ? "✅ /help passed" : `❌ /help failed. Calls: ${JSON.stringify(helpCalls, null, 2)}`);

// 2. Test Allowlisted User - /status command
console.log("\nTesting allowlisted user sending /status...");
const statusCalls = await simulateUpdate({
  update_id: 10002,
  message: {
    message_id: 102,
    from: { id: ALLOWED_ID, is_bot: false, first_name: "Pedro" },
    chat: { id: ALLOWED_ID, type: "private", first_name: "Pedro" },
    date: Math.floor(Date.now() / 1000),
    text: "/status",
    entities: [{ offset: 0, length: 7, type: "bot_command" }],
  },
});

const statusPassed = statusCalls.length === 1 &&
  statusCalls[0]!.method === "sendMessage" &&
  statusCalls[0]!.payload.chat_id === ALLOWED_ID &&
  statusCalls[0]!.payload.text.includes("Estado / Status");

console.log(statusPassed ? "✅ /status passed" : `❌ /status failed. Calls: ${JSON.stringify(statusCalls, null, 2)}`);

// 3. Test Blocked User (non-allowlisted) - Any message
console.log("\nTesting non-allowlisted user sending message...");
const blockedCalls = await simulateUpdate({
  update_id: 10003,
  message: {
    message_id: 103,
    from: { id: 999999999, is_bot: false, first_name: "Stranger" },
    chat: { id: 999999999, type: "private", first_name: "Stranger" },
    date: Math.floor(Date.now() / 1000),
    text: "/help",
  },
});

const blockedPassed = blockedCalls.length === 1 &&
  blockedCalls[0]!.method === "sendMessage" &&
  blockedCalls[0]!.payload.chat_id === 999999999 &&
  blockedCalls[0]!.payload.text === "This bot is private.";

console.log(blockedPassed ? "✅ Allowlist block passed" : "❌ Allowlist block failed");

// 4. Test Status with Configured Tenant
console.log("\nTesting /status with configured tenant in DB...");
db.run(
  "INSERT OR REPLACE INTO tenants (chat_id, name, account_ids, platforms, created_at) VALUES (?, ?, ?, ?, ?)",
  [ALLOWED_ID, "Pedro's Hub", JSON.stringify(["acc1", "acc2"]), JSON.stringify(["instagram", "linkedin"]), Date.now()]
);

const statusTenantCalls = await simulateUpdate({
  update_id: 10004,
  message: {
    message_id: 104,
    from: { id: ALLOWED_ID, is_bot: false, first_name: "Pedro" },
    chat: { id: ALLOWED_ID, type: "private", first_name: "Pedro" },
    date: Math.floor(Date.now() / 1000),
    text: "/status",
    entities: [{ offset: 0, length: 7, type: "bot_command" }],
  },
});

const statusTenantPassed = statusTenantCalls.length === 1 &&
  statusTenantCalls[0]!.method === "sendMessage" &&
  statusTenantCalls[0]!.payload.chat_id === ALLOWED_ID &&
  statusTenantCalls[0]!.payload.text.includes("Pedro's Hub") &&
  statusTenantCalls[0]!.payload.text.includes("instagram, linkedin");

console.log(statusTenantPassed ? "✅ /status with tenant passed" : `❌ /status with tenant failed. Calls: ${JSON.stringify(statusTenantCalls, null, 2)}`);

// Clean up the test tenant so we don't leave side-effects
db.run("DELETE FROM tenants WHERE chat_id = ?", [ALLOWED_ID]);

// Clean up DB handle so script exits cleanly
db.close();

// Final assessment
const allPassed = helpPassed && statusPassed && blockedPassed && statusTenantPassed;
console.log(`\nFinal result: ${allPassed ? "PASS" : "FAIL"}`);
process.exit(allPassed ? 0 : 1);
