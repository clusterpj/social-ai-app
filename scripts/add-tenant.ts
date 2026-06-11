import { Database } from "bun:sqlite";

// Connect to the database directly
const db = new Database("data/app.db");

try {
  db.run(
    "INSERT OR REPLACE INTO tenants (chat_id, name, account_ids, platforms, created_at) VALUES (?, ?, ?, ?, ?)",
    [
      913340424, 
      "Pedro's Test Account", 
      JSON.stringify(["facebook"]), // Using the account found in the Zernio test
      JSON.stringify(["facebook"]), // Corresponding platform
      Date.now()
    ]
  );
  console.log("✅ Successfully inserted your chat ID (913340424) into the tenants database!");
} catch (err) {
  console.error("❌ Failed to insert tenant:", err);
} finally {
  db.close();
}
