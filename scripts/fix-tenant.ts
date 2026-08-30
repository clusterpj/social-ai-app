import { zernioAdapter } from "../src/services/publisher/zernio";
import { Database } from "bun:sqlite";

async function fixTenant() {
  console.log("Fetching accounts from Zernio...");
  const accounts = await zernioAdapter.listAccounts();
  console.log("Found accounts:", JSON.stringify(accounts, null, 2));

  if (accounts.length === 0) {
    console.log("No accounts found! The user needs to connect an account in the Zernio dashboard.");
    return;
  }

  const accountIds = accounts.map(a => a.id);
  const platforms = accounts.map(a => a.platform);

  console.log("Updating database with correct IDs...");
  const db = new Database("data/app.db");
  db.run(
    "UPDATE tenants SET account_ids = ?, platforms = ? WHERE chat_id = ?",
    [JSON.stringify(accountIds), JSON.stringify(platforms), 913340424]
  );
  db.close();

  console.log("✅ Fixed tenant 913340424 with real account IDs!");
  process.exit(0);
}

fixTenant();
