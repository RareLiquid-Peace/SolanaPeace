import { Connection } from "@solana/web3.js";
import { RPC_URL, WALLET_KEYPAIR } from "../config.js";

const connection = new Connection(RPC_URL, "confirmed");

export async function getWalletBalance() {
  try {
    const lamports = await connection.getBalance(WALLET_KEYPAIR.publicKey);
    const sol = lamports / 1e9;
    return sol;
  } catch (error) {
    console.error("❌ Failed to fetch wallet balance:", error);
    return 0;
  }
}
