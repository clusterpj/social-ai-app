import { bot } from "../src/bot";
import { config } from "../src/config";
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

  // 2. LLM Copy Generation
  try {
    const provider = config.OPENROUTER_API_KEY 
      ? "OpenRouter" 
      : config.ANTHROPIC_API_KEY 
        ? "Anthropic" 
        : config.DEEPSEEK_API_KEY 
          ? "DeepSeek" 
          : "None";
    process.stdout.write(`LLM Copy (${provider}).... `);
    const copy = await generateCopy("Say hello world in 3 words", ["x"], undefined, 0, 10000);
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
