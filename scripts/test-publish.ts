import { config } from "../src/config";

async function testPublish() {
  const body = {
    publishNow: true,
    platforms: [
      {
        platform: "facebook",
        accountId: "6a299e2c62c262a32c60711b",
        customContent: "Testing mediaItems array of objects"
      }
    ],
    mediaItems: [{ url: "https://picsum.photos/800/600.jpg" }]
  };

  const res = await fetch("https://zernio.com/api/v1/posts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${config.ZERNIO_API_KEY}`,
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text);
}

testPublish();
