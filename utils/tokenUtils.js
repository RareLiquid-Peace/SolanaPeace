import fetch from "node-fetch";

// 📊 Get token info from Dexscreener API
export async function getTokenInfoFromDexscreener(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${mint}`;
    const response = await fetch(url);
    const json = await response.json();

    if (!json || !json.pair) return null;

    const pair = json.pair;

    return {
      liquidityUsd: parseFloat(pair.liquidity?.usd || 0),
      marketCapUsd: parseFloat(pair.fdv || 0),
      volume24h: parseFloat(pair.volume?.h24 || 0),
      priceChange5m: parseFloat(pair.priceChange?.m5 || 0),
    };
  } catch (error) {
    console.error("❌ Dexscreener fetch error:", error.message);
    return null;
  }
}

// 📈 Simulate basic holder check
export async function getHolderData(mint) {
  try {
    // ❗ You can replace this with real Solana holder API later
    return {
      topHolderPercent: Math.floor(Math.random() * 15) + 5, // Random 5–20%
      totalHolders: Math.floor(Math.random() * 500) + 100,
    };
  } catch (error) {
    console.error("❌ Holder fetch error:", error.message);
    return null;
  }
}
