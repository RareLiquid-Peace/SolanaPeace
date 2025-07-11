import {
  SLIPPAGE_BPS,
  TAKE_PROFIT_PERCENT_DANGER,
  TAKE_PROFIT_PERCENT_WARNING,
  TAKE_PROFIT_GOOD_TIERS,
  TRAILING_STOP_LOSS_PERCENT,
  DEEP_LOSS_PERCENT_DANGER,
  CLOSE_ATA_DELAY_MS,
  WALLET_KEYPAIR,
} from "../config.js";

import { getTokenPrice, getBestSwap, sellToken } from "../utils/priceFetcher.js";
import { getWalletBalance } from "../utils/walletUtils.js";
import {
  logEvent,
  logTrade,
  addPurchasedToken,
  updateTradeStatus
} from "./databaseService.js";
import { sendTelegramMessage } from "./telegramService.js";

const portfolio = new Map();

export function getPortfolio() {
  return portfolio;
}

export function getPortfolioSize() {
  return portfolio.size;
}

export function getTotalPnlUsd() {
  let total = 0;
  for (const trade of portfolio.values()) {
    total += trade.pnlUsd || 0;
  }
  return total;
}

export async function buyToken(mint, riskLevel, metadata) {
  const walletSol = await getWalletBalance();
  const amountInSol = walletSol * 0.5;

  if (amountInSol < 0.001) {
    await logEvent("WARN", `💤 Not enough SOL to trade (${amountInSol.toFixed(6)} SOL). Skipping.`);
    return;
  }

  const entryPrice = await getTokenPrice(mint);
  const swap = await getBestSwap(mint, amountInSol, SLIPPAGE_BPS);
  if (!swap || swap.error) {
    await logEvent("WARN", `Swap failed for ${mint}: ${swap?.error}`);
    return;
  }

  await logEvent("TRADE", `✅ BUYING ${mint} [${riskLevel.toUpperCase()}] at ${entryPrice} SOL (Amt: ${amountInSol.toFixed(6)})`);

  portfolio.set(mint, {
    purchasePrice: entryPrice,
    tradeAmountSol: amountInSol,
    riskLevel,
    profitTakenLevels: [],
    purchaseTimestamp: Date.now(),
    highestPriceSeen: entryPrice,
  });

  // 🔁 Log trade in DB
  await logTrade("BUY", mint, amountInSol, entryPrice, 0.00001, swap.signature || "N/A", null);
  await addPurchasedToken(mint);

  await sendTelegramMessage(`🟢 Bought ${metadata.symbol} (${riskLevel}) @ ${entryPrice} SOL\nAmount: ${amountInSol.toFixed(6)} SOL`);
}

export async function monitorPortfolio() {
  for (const [mint, position] of portfolio.entries()) {
    const currentPrice = await getTokenPrice(mint);
    if (!currentPrice) continue;

    const { purchasePrice, tradeAmountSol, riskLevel } = position;
    const pnlPercent = ((currentPrice - purchasePrice) / purchasePrice) * 100;

    if (currentPrice > (position.highestPriceSeen || 0)) {
      position.highestPriceSeen = currentPrice;
    }

    // 🛑 Trailing Stop-Loss
    if (
      position.highestPriceSeen &&
      currentPrice < position.highestPriceSeen * (1 - TRAILING_STOP_LOSS_PERCENT / 100)
    ) {
      await exitTrade(mint, currentPrice, "Trailing Stop Loss Triggered");
      continue;
    }

    // 🔻 Deep Loss (Only for DANGER)
    if (
      riskLevel === "DANGER" &&
      pnlPercent <= DEEP_LOSS_PERCENT_DANGER
    ) {
      await exitTrade(mint, currentPrice, "Deep Stop Loss Triggered");
      continue;
    }

    // 🏁 Take Profits
    if (riskLevel === "DANGER" && pnlPercent >= TAKE_PROFIT_PERCENT_DANGER) {
      await exitTrade(mint, currentPrice, "Take Profit (DANGER)");
    } else if (riskLevel === "WARNING" && pnlPercent >= TAKE_PROFIT_PERCENT_WARNING) {
      await exitTrade(mint, currentPrice, "Take Profit (WARNING)");
    } else if (riskLevel === "GOOD") {
      if (!position.profitTakenLevels.includes("TP1") && pnlPercent >= TAKE_PROFIT_GOOD_TIERS.TP1.PROFIT_PERCENT) {
        await partialExit(mint, TAKE_PROFIT_GOOD_TIERS.TP1.SELL_PERCENT, "TP1 Triggered");
        position.profitTakenLevels.push("TP1");
      }
      if (!position.profitTakenLevels.includes("TP2") && pnlPercent >= TAKE_PROFIT_GOOD_TIERS.TP2.PROFIT_PERCENT) {
        await partialExit(mint, TAKE_PROFIT_GOOD_TIERS.TP2.SELL_PERCENT, "TP2 Triggered");
        position.profitTakenLevels.push("TP2");
      }
      if (!position.profitTakenLevels.includes("TP3") && pnlPercent >= TAKE_PROFIT_GOOD_TIERS.TP3.PROFIT_PERCENT) {
        await exitTrade(mint, currentPrice, "TP3 Final Take Profit");
        portfolio.delete(mint);
      }
    }
  }
}

async function exitTrade(mint, price, reason) {
  const position = portfolio.get(mint);
  if (!position) return;

  await sellToken(mint, 100, SLIPPAGE_BPS); // Sell 100%
  portfolio.delete(mint);

  await logEvent("EXIT", `Sold ${mint} due to ${reason} @ ${price} SOL`);
  await updateTradeStatus("N/A", "SOLD");

  await sendTelegramMessage(`🔴 Exited ${mint}\nReason: ${reason}\nExit Price: ${price} SOL`);

  await sleep(CLOSE_ATA_DELAY_MS);
}

async function partialExit(mint, percent, reason) {
  await sellToken(mint, percent, SLIPPAGE_BPS);
  await logEvent("EXIT", `Partial sell ${percent}% of ${mint} - ${reason}`);
  await sendTelegramMessage(`🟡 Partial Sell ${percent}% of ${mint} - ${reason}`);
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
