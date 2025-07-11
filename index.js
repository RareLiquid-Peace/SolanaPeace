import { Connection, PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_LIQUIDITY_POOL_V4,
  RPC_URL,
  WALLET_KEYPAIR,
  MAX_PORTFOLIO_SIZE,
  SOL_MINT,
  GLOBAL_STOP_LOSS_USD,
} from "./config.js";
import {
  buyToken,
  monitorPortfolio,
  getPortfolioSize,
  getTotalPnlUsd,
  getPortfolio,
} from "./services/tradeService.js";
import { getTokenMetadata, checkRug } from "./services/vettingService.js";
import {
  initDb,
  logEvent,
  hasBeenPurchased,
  loadActiveTrades,
} from "./services/databaseService.js";
import { loadBlacklist, isBlacklisted } from "./services/blacklistService.js";
import chalk from "chalk";
import express from "express";

const app = express();
const seenSignatures = new Set();
const connection = new Connection(RPC_URL, "confirmed");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processNewLiquidityPool(transaction) {
  try {
    if (getPortfolioSize() >= MAX_PORTFOLIO_SIZE) return;

    if (
      !transaction ||
      !transaction.meta ||
      !transaction.meta.postTokenBalances
    )
      return;

    const postTokenBalances = transaction.meta.postTokenBalances;
    const newMintInfo = postTokenBalances.find(
      (tb) =>
        tb.mint !== SOL_MINT &&
        tb.owner === "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
    );
    if (!newMintInfo) return;

    const newMint = newMintInfo.mint;
    if (await hasBeenPurchased(newMint)) return;

    const metadata = await getTokenMetadata(newMint);
    if (!metadata) {
      await logEvent("WARN", `No metadata found for ${newMint}. Skipping.`);
      return;
    }

    if (isBlacklisted(metadata.name, metadata.symbol)) {
      await logEvent(
        "WARN",
        `Blacklisted token skipped: ${metadata.name} (${metadata.symbol})`
      );
      return;
    }

    await logEvent(
      "INFO",
      `🆕 New token found: ${metadata.name} (${metadata.symbol}) | Mint: ${newMint}`
    );
    await sleep(500); // optional delay for safety

    const rugCheckReport = await checkRug(newMint);
    if (!rugCheckReport) {
      await logEvent("WARN", `Vetting failed for ${newMint}. Skipping.`);
      return;
    }

    await buyToken(newMint, rugCheckReport.risk.level, metadata);
  } catch (error) {
    await logEvent("ERROR", "❌ Error in pool detection:", { error });
  }
}

async function monitorNewPools() {
  await logEvent("INFO", "⏳ Monitoring new Raydium liquidity pools...");
  connection.onLogs(
    new PublicKey(RAYDIUM_LIQUIDITY_POOL_V4),
    async ({ logs, signature }) => {
      if (
        seenSignatures.has(signature) ||
        !logs.some((log) => log.includes("initialize2"))
      )
        return;
      seenSignatures.add(signature);
      try {
        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        await processNewLiquidityPool(tx);
      } catch (error) {
        await logEvent("ERROR", "Failed to get parsed tx", {
          signature,
          error,
        });
      }
    },
    "confirmed"
  );
}

function startHealthCheckServer() {
  app.get("/health", (req, res) => {
    res.status(200).send("OK");
  });
  app.listen(process.env.PORT || 3000, () => {
    logEvent("INFO", `✅ Health check active on port ${process.env.PORT}`);
  });
}

async function main() {
  await initDb();
  await loadBlacklist();

  const activeTrades = await loadActiveTrades();
  const portfolio = getPortfolio();
  for (const trade of activeTrades) {
    portfolio.set(trade.mint_address, {
      purchasePrice: trade.token_price_in_sol,
      amount: 0,
      tradeAmountSol: trade.sol_amount,
      riskLevel: "UNKNOWN",
      profitTakenLevels: [],
      purchaseTimestamp: new Date(trade.timestamp).getTime(),
      highestPriceSeen: trade.token_price_in_sol,
      buySignature: trade.signature,
    });
  }

  await logEvent("INFO", `📊 Loaded ${portfolio.size} active trades.`);

  console.log(
    chalk.bold.magenta("====================================================")
  );
  console.log(
    chalk.bold.magenta("   🚀 Solana AI Trading Bot GOAT Edition Launched 🚀 ")
  );
  console.log(
    chalk.bold.magenta("====================================================")
  );

  await logEvent("INFO", `Wallet: ${WALLET_KEYPAIR.publicKey.toBase58()}`);
  startHealthCheckServer();
  monitorNewPools();

  setInterval(async () => {
    await logEvent("INFO", "📈 Running portfolio safety check...");
    await monitorPortfolio();

    const currentPnl = getTotalPnlUsd();
    if (currentPnl <= GLOBAL_STOP_LOSS_USD) {
      await logEvent("ERROR", "🛑 GLOBAL STOP-LOSS TRIGGERED! BOT EXITING.", {
        totalPnlUsd: currentPnl,
      });
      process.exit(1);
    }
  }, 30000);
}

main();
