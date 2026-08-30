import { Database } from "bun:sqlite";

const db = new Database("data/app.db");

// Help text
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Usage: bun run scripts/add-tenant.ts <chat_id> <name> <account_ids> <platforms>

Arguments:
  chat_id      The Telegram chat ID (integer)
  name         The display name for the tenant
  account_ids  Comma-separated list of Zernio account IDs
  platforms    Comma-separated list of platforms (instagram, linkedin, x, facebook)

Example:
  bun run scripts/add-tenant.ts 184758209 "Pedro's Hub" 6a299e2c62c262a32c60711b,6a299e2c62c262a32c60711c instagram,linkedin
`);
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.length < 4) {
  console.error("❌ Error: Missing arguments. Run with --help to see usage instructions.");
  db.close();
  process.exit(1);
}

const chatId = Number(args[0]);
const name = args[1]!;
const accountIds = args[2]!.split(",").map(s => s.trim());
const platforms = args[3]!.split(",").map(s => s.trim().toLowerCase());

if (isNaN(chatId)) {
  console.error("❌ Error: chat_id must be a number");
  db.close();
  process.exit(1);
}

const allowedPlatforms = ["instagram", "linkedin", "x", "facebook"];
for (const p of platforms) {
  if (!allowedPlatforms.includes(p)) {
    console.error(`❌ Error: Invalid platform "${p}". Must be one of: ${allowedPlatforms.join(", ")}`);
    db.close();
    process.exit(1);
  }
}

if (accountIds.length !== platforms.length) {
  console.error("❌ Error: Number of account_ids must match the number of platforms.");
  db.close();
  process.exit(1);
}

try {
  db.run(
    "INSERT OR REPLACE INTO tenants (chat_id, name, account_ids, platforms, created_at) VALUES (?, ?, ?, ?, ?)",
    [
      chatId,
      name,
      JSON.stringify(accountIds),
      JSON.stringify(platforms),
      Date.now()
    ]
  );
  console.log(`✅ Successfully provisioned tenant "${name}" (Chat ID: ${chatId})!`);
  console.log(`🔗 Platforms: ${platforms.join(", ")}`);
  console.log(`🔑 Account IDs: ${accountIds.join(", ")}`);
} catch (err) {
  console.error("❌ Failed to insert tenant:", err);
} finally {
  db.close();
}
