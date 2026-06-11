import { bot } from "../src/bot";
import { generateCopy } from "../src/services/copy";
import { generateImage } from "../src/services/image";
import { zernioAdapter } from "../src/services/publisher/zernio";

async function run() {
  console.log("=== Testing API Connections ===\n");

  // 1. Telegram
  try {
    process.stdout.write("Telegram (getMe)..... ");
    const me = await bot.api.getMe();
    console.log(`✅ OK (@${me.username})`);
  } catch (err) {
    console.log(`❌ FAILED`);
    console.error(err instanceof Error ? err.message : err);
  }

  // 2. Anthropic
  try {
    process.stdout.write("Anthropic (Copy)..... ");
    const copy = await generateCopy("Say hello world in 3 words", ["x"], 0, 10000);
    console.log(`✅ OK (Generated: "${copy.x}")`);
  } catch (err) {
    console.log(`❌ FAILED`);
    console.error(err instanceof Error ? err.message : err);
  }

  // 3. fal.ai (Flux)
  try {
    process.stdout.write("fal.ai (Image)....... ");
    const imagePath = await generateImage("A solid blue square", 30000);
    console.log(`✅ OK (Saved to: ${imagePath})`);
  } catch (err) {
    console.log(`❌ FAILED`);
    console.error(err instanceof Error ? err.message : err);
  }

  // 4. Zernio
  try {
    process.stdout.write("Zernio (Accounts).... ");
    const accounts = await zernioAdapter.listAccounts();
    console.log(`✅ OK (Found ${accounts.length} accounts: ${accounts.map(a => a.platform).join(', ')})`);
  } catch (err) {
    console.log(`❌ FAILED`);
    console.error(err instanceof Error ? err.message : err);
  }

  console.log("\n=== Done ===");
  process.exit(0);
}

run();
