import { getTokenInfoFromDexscreener, getHolderData } from "../utils/tokenUtils.js";
import {
  MIN_LIQUIDITY_USD,
  MIN_MARKET_CAP_USD,
  MAX_HOLDER_PERCENT,
  MIN_HOLDER_COUNT,
} from "../config.js";
import { logEvent } from "./databaseService.js";

// ✅ Get token metadata from Dexscreener
export async function getTokenMetadata(mintAddress) {
  const info = await getTokenInfoFromDexscreener(mintAddress);
  if (!info) return null;

  return {
    liquidityUsd: info.liquidityUsd,
    marketCapUsd: info.marketCapUsd,
    volume24h: info.volume24h,
    priceChange5m: info.priceChange5m,
  };
}

// ✅ Full rug check logic
export async function checkRug(mintAddress) {
  const tokenInfo = await getTokenInfoFromDexscreener(mintAddress);
  const holderInfo = await getHolderData(mintAddress);

  if (!tokenInfo || !holderInfo) {
    await logEvent("WARN", "Missing token or holder info for rug check", { mintAddress });
    return { isSafe: false, risk: "UNKNOWN", reason: "No data found" };
  }

  const {
    liquidityUsd,
    marketCapUsd,
    volume24h,
    priceChange5m
  } = tokenInfo;

  const {
    topHolderPercent,
    totalHolders
  } = holderInfo;

  // 🟥 High Risk (RUG)
  if (
    liquidityUsd < MIN_LIQUIDITY_USD ||
    marketCapUsd < MIN_MARKET_CAP_USD ||
    topHolderPercent > MAX_HOLDER_PERCENT ||
    totalHolders < MIN_HOLDER_COUNT
  ) {
    return {
      isSafe: false,
      risk: "DANGER",
      reason: "Low liquidity / High holder concentration / Low cap",
      tokenInfo,
      holderInfo
    };
  }

  // 🟡 Medium Risk
  if (priceChange5m < -30 || volume24h < 1000) {
    return {
      isSafe: true,
      risk: "WARNING",
      reason: "Volatile or low volume",
      tokenInfo,
      holderInfo
    };
  }

  // ✅ Safe token
  return {
    isSafe: true,
    risk: "GOOD",
    reason: "Passed all checks",
    tokenInfo,
    holderInfo
  };
}
