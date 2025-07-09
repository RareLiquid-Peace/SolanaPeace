// tradeService.js — GOAT-Level Version (Risk-Free, 0.01 SOL Optimized)

import {
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import {
  WALLET_KEYPAIR,
  SLIPPAGE_BPS,
  SOL_MINT,
  TRAILING_STOP_LOSS_PERCENT,
  TRADE_AMOUNTS,
  TAKE_PROFIT_GOOD_TIERS,
  TAKE_PROFIT_PERCENT_DANGER,
  TAKE_PROFIT_PERCENT_WARNING,
  STALE_DANGER_COIN_MINUTES,
  DEEP_LOSS_PERCENT_DANGER,
  MIN_SOL_BALANCE,
  CLOSE_ATA_DELAY_MS,
} from "../config.js";
import {
  sendAndConfirmTransaction,
  getTokenPriceInSol,
  connection,
  getSolPriceUsd,
} from "./solanaService.js";
import {
  logEvent,
  logTrade,
  addPurchasedToken,
  updateTradeStatus,
} from "./databaseService.js";
import { addToBlacklist } from "./blacklistService.js";
import fetch from "cross-fetch";

const portfolio = new Map();
let totalPnlUsd = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function getPortfolioSize() {
  return portfolio.size;
}

export function getTotalPnlUsd() {
  return totalPnlUsd;
}

export function getPortfolio() {
  return portfolio;
}

export async function buyToken(mintAddress, riskLevel, metadata) {
  const tradeAmountSol = TRADE_AMOUNTS[riskLevel] || TRADE_AMOUNTS.DANGER;
  const walletBalance = await connection.getBalance(WALLET_KEYPAIR.publicKey);

  if (walletBalance / LAMPORTS_PER_SOL < tradeAmountSol + MIN_SOL_BALANCE) {
    await logEvent("ERROR", "Insufficient SOL balance.", {
      current: walletBalance / LAMPORTS_PER_SOL,
      required: tradeAmountSol + MIN_SOL_BALANCE,
    });
    return false;
  }

  await logEvent("INFO", `Attempting to buy ${mintAddress} for ${tradeAmountSol} SOL`, { riskLevel }, totalPnlUsd);

  try {
    const amountInLamports = Math.round(tradeAmountSol * LAMPORTS_PER_SOL);
    const quoteResponse = await (
      await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mintAddress}&amount=${amountInLamports}&slippageBps=${SLIPPAGE_BPS}`
      )
    ).json();

    const { swapTransaction } = await (
      await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: WALLET_KEYPAIR.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: "auto",
        }),
      })
    ).json();

    if (!swapTransaction) throw new Error("Swap transaction missing.");

    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    const latestBlockhash = await connection.getLatestBlockhash();
    const txResult = await sendAndConfirmTransaction(transaction, latestBlockhash);

    if (txResult) {
      const purchasePrice = await getTokenPriceInSol(mintAddress);
      if (purchasePrice > 0) {
        const tokenAta = await getAssociatedTokenAddress(
          new PublicKey(mintAddress),
          WALLET_KEYPAIR.publicKey
        );
        const balanceResponse = await connection.getTokenAccountBalance(tokenAta);

        portfolio.set(mintAddress, {
          purchasePrice,
          amount: balanceResponse.value.amount,
          tradeAmountSol,
          riskLevel,
          profitTakenLevels: [],
          purchaseTimestamp: Date.now(),
          highestPriceSeen: purchasePrice,
          buySignature: txResult.signature,
        });

        await addPurchasedToken(mintAddress);
        await logTrade("BUY", mintAddress, tradeAmountSol, purchasePrice, txResult.fee, txResult.signature, totalPnlUsd);
        await addToBlacklist(metadata.name, metadata.symbol);

        return true;
      }
    }
    return false;
  } catch (error) {
    await logEvent("ERROR", `Buy failed for ${mintAddress}: ${error.message}`, null, totalPnlUsd);
    return false;
  }
}

export async function sellToken(mintAddress, sellPercentage) {
  const maxRetries = 3;
  const retryDelay = 5000;
  const position = portfolio.get(mintAddress);
  if (!position) return false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tokenAta = await getAssociatedTokenAddress(
        new PublicKey(mintAddress),
        WALLET_KEYPAIR.publicKey
      );
      const balanceResponse = await connection.getTokenAccountBalance(tokenAta);
      const onChainBalance = parseInt(balanceResponse.value.amount, 10);
      if (isNaN(onChainBalance) || onChainBalance === 0) {
        portfolio.delete(mintAddress);
        await updateTradeStatus(position.buySignature, "SOLD");
        return false;
      }

      const amountToSell = Math.round((onChainBalance * sellPercentage) / 100);
      if (amountToSell <= 0) return false;

      const quoteResponse = await (
        await fetch(
          `https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${SOL_MINT}&amount=${amountToSell}&slippageBps=${SLIPPAGE_BPS}`
        )
      ).json();

      const { swapTransaction } = await (
        await fetch("https://quote-api.jup.ag/v6/swap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quoteResponse,
            userPublicKey: WALLET_KEYPAIR.publicKey.toString(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: "auto",
          }),
        })
      ).json();

      const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      const latestBlockhash = await connection.getLatestBlockhash();
      const txResult = await sendAndConfirmTransaction(transaction, latestBlockhash);

      if (txResult) {
        const sellPrice = (await getTokenPriceInSol(mintAddress)) || 0;
        const receivedSol = parseInt(quoteResponse.outAmount, 10) / LAMPORTS_PER_SOL;
        const initialInvestment = position.tradeAmountSol * (sellPercentage / 100);
        const profitInSol = receivedSol - initialInvestment;
        const solPrice = await getSolPriceUsd();
        if (solPrice > 0) totalPnlUsd += profitInSol * solPrice;

        await logTrade("SELL", mintAddress, receivedSol, sellPrice, txResult.fee, txResult.signature, totalPnlUsd);

        if (sellPercentage === 100) {
          portfolio.delete(mintAddress);
          await updateTradeStatus(position.buySignature, "SOLD");
          await closeTokenAccount(mintAddress);
        } else {
          position.amount = (parseInt(position.amount) - amountToSell).toString();
        }
        return true;
      }
    } catch (error) {
      await sleep(retryDelay);
    }
  }
  await updateTradeStatus(position.buySignature, "SELL_FAILED");
  return false;
}

async function closeTokenAccount(mintAddress) {
  await sleep(CLOSE_ATA_DELAY_MS);
  try {
    const tokenAta = await getAssociatedTokenAddress(
      new PublicKey(mintAddress),
      WALLET_KEYPAIR.publicKey
    );
    const closeInstruction = createCloseAccountInstruction(
      tokenAta,
      WALLET_KEYPAIR.publicKey,
      WALLET_KEYPAIR.publicKey
    );
    const latestBlockhash = await connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: WALLET_KEYPAIR.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [closeInstruction],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    await sendAndConfirmTransaction(tx, latestBlockhash);
  } catch (error) {
    await sleep(2000);
  }
}

export async function monitorPortfolio() {
  if (portfolio.size === 0) return;
  for (const [mintAddress, position] of portfolio.entries()) {
    const currentPrice = await getTokenPriceInSol(mintAddress);
    if (currentPrice === 0) {
      await sellToken(mintAddress, 100);
      continue;
    }
    if (currentPrice > position.highestPriceSeen) {
      position.highestPriceSeen = currentPrice;
    }
    const pnlPercentage = ((currentPrice - position.purchasePrice) / position.purchasePrice) * 100;
    const dropFromPeak = ((position.highestPriceSeen - currentPrice) / position.highestPriceSeen) * 100;

    if (pnlPercentage > 0 && dropFromPeak >= TRAILING_STOP_LOSS_PERCENT) {
      await sellToken(mintAddress, 100);
      continue;
    }
    if (pnlPercentage <= -10) {
      await sellToken(mintAddress, 100);
      continue;
    }
    const timeHeldMins = (Date.now() - position.purchaseTimestamp) / 60000;
    if (position.riskLevel === "DANGER" && pnlPercentage > 0 && timeHeldMins > STALE_DANGER_COIN_MINUTES) {
      await sellToken(mintAddress, 100);
      continue;
    }
    if (position.riskLevel === "DANGER" && pnlPercentage <= DEEP_LOSS_PERCENT_DANGER) {
      await sellToken(mintAddress, 100);
      continue;
    }

    if (position.riskLevel === "GOOD") {
      const { TP1, TP2, TP3 } = TAKE_PROFIT_GOOD_TIERS;
      if (pnlPercentage >= TP3.PROFIT_PERCENT && !position.profitTakenLevels.includes(3)) {
        await sellToken(mintAddress, TP3.SELL_PERCENT);
      } else if (pnlPercentage >= TP2.PROFIT_PERCENT && !position.profitTakenLevels.includes(2)) {
        position.profitTakenLevels.push(2);
        await sellToken(mintAddress, TP2.SELL_PERCENT);
      } else if (pnlPercentage >= TP1.PROFIT_PERCENT && !position.profitTakenLevels.includes(1)) {
        position.profitTakenLevels.push(1);
        await sellToken(mintAddress, TP1.SELL_PERCENT);
      }
    }
    if (position.riskLevel === "WARNING" && pnlPercentage >= TAKE_PROFIT_PERCENT_WARNING) {
      await sellToken(mintAddress, 100);
    }
    if (position.riskLevel === "DANGER" && pnlPercentage >= TAKE_PROFIT_PERCENT_DANGER) {
      await sellToken(mintAddress, 100);
    }
  }
}
