import fetch from "node-fetch";
import { SLIPPAGE_BPS } from "../config.js";

export async function getTokenPrice(mint) {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint}&amount=10000000&slippageBps=100`;
    const res = await fetch(url);
    const json = await res.json();

    if (!json || !json.outAmount) return null;

    const price = parseFloat(json.outAmount) / 1e9 / 0.01; // price per 1 SOL worth
    return price;
  } catch (err) {
    console.error("❌ getTokenPrice error:", err.message);
    return null;
  }
}

export async function getBestSwap(mint, amountInSol, slippageBps = SLIPPAGE_BPS) {
  try {
    const amountLamports = Math.floor(amountInSol * 1e9);

    const url = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
    const res = await fetch(url);
    const json = await res.json();

    if (!json || !json.outAmount) {
      return { error: "No route found" };
    }

    return {
      outAmount: parseFloat(json.outAmount),
      inAmount: amountLamports,
      outAmountSol: parseFloat(json.outAmount) / 1e9,
    };
  } catch (err) {
    return { error: err.message };
  }
}

export async function sellToken(mint, percent, slippageBps) {
  console.log(`🔁 [SIMULATED] Selling ${percent}% of ${mint} with ${slippageBps} slippage`);
}
