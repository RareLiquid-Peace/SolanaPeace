import axios from "axios";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from "../config.js";

export async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }
    );
  } catch (error) {
    console.error("Telegram Error:", error.message);
  }
}
