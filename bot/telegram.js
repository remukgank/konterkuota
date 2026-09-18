"use strict";

const { Bot, InputFile } = require("grammy");
const { BOT_TOKEN, ALLOWED_CHAT_IDS } = require("../src/config");

let bot = null;

function createCompatibilityAdapter(coreBot) {
  return {
    onText(pattern, handler) {
      coreBot.on("message", (ctx, next) => {
        const text = ctx.message && ctx.message.text;
        if (typeof text !== "string") return next();
        pattern.lastIndex = 0;
        const match = pattern.exec(text);
        if (match) handler(ctx.message, match);
        return next();
      });
    },

    on(updateType, handler) {
      coreBot.on(updateType, (ctx, next) => {
        if (updateType === "message") handler(ctx.message);
        else if (updateType === "callback_query") handler(ctx.callbackQuery);
        else handler(ctx.update);
        return next();
      });
    },

    sendMessage(chatId, text, options = {}) {
      return coreBot.api.sendMessage(chatId, text, options);
    },

    editMessageText(chatId, messageId, text, options = {}) {
      return coreBot.api.editMessageText(chatId, messageId, text, options);
    },

    sendRichMessage(chatId, html, fallback, options = {}) {
      const payload = { chat_id: chatId, rich_message: { html } };
      if (options.reply_markup) payload.reply_markup = options.reply_markup;
      if (options.reply_to_message_id) payload.reply_to_message_id = options.reply_to_message_id;
      return coreBot.api.raw.sendRichMessage(payload).catch(() =>
        coreBot.api.sendMessage(chatId, fallback, {
          parse_mode: options.parse_mode,
          reply_markup: options.reply_markup,
          ...(options.reply_to_message_id
            ? { reply_to_message_id: options.reply_to_message_id }
            : {}),
        })
      );
    },

    deleteMessage(chatId, messageId) {
      return coreBot.api.deleteMessage(chatId, messageId);
    },

    sendPhoto(chatId, photo, options = {}) {
      const input = Buffer.isBuffer(photo)
        ? new InputFile(photo, "captcha.png")
        : photo;
      return coreBot.api.sendPhoto(chatId, input, options);
    },

    answerCallbackQuery(callbackQueryId, options = {}) {
      return coreBot.api.answerCallbackQuery(callbackQueryId, options);
    },

    sendChatAction(chatId, action = "typing") {
      return coreBot.api.sendChatAction(chatId, action);
    },
  };
}

function initBot() {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN belum diisi. Isi di env/.env lalu jalankan ulang.");
  }
  const coreBot = new Bot(BOT_TOKEN);
  coreBot.catch((err) => {
    const e = err.error || err;
    console.error("grammY error:", e.description || e.message || err.message);
  });
  bot = createCompatibilityAdapter(coreBot);
  setImmediate(() => {
    coreBot.start().catch((e) => {
      console.error("Telegram polling gagal:", e.message);
      process.exitCode = 1;
    });
  });
  return bot;
}

function isAllowed(chatId) {
  if (!ALLOWED_CHAT_IDS.length) return true;
  return ALLOWED_CHAT_IDS.includes(chatId);
}

function guard(fn) {
  return (msg) => {
    const chatId = msg.chat.id;
    if (!isAllowed(chatId)) {
      bot.sendMessage(
        chatId,
        "🔒 Fitur ini hanya untuk admin (ALLOWED_CHAT_IDS)."
      );
      return;
    }
    fn(msg);
  };
}

function reply(msg, text, opts) {
  return bot.sendMessage(msg.chat.id, text, opts);
}

function inlineButtons(rows) {
  const nested = rows.map((row) => (Array.isArray(row) ? row : [row]));
  return {
    reply_markup: {
      inline_keyboard: nested.map((row) =>
        row.map((b) =>
          b.url
            ? { text: b.text, url: b.url }
            : { text: b.text, callback_data: b.data }
        )
      ),
    },
  };
}

function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } };
}

module.exports = {
  initBot,
  isAllowed,
  guard,
  reply,
  inlineButtons,
  removeKeyboard,
  get bot() {
    return bot;
  },
};
