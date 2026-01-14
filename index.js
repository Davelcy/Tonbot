/**
 * index.js - Main bot (complete)
 *
 * - Force channel join AND device verification required to access the bot and to receive the new-user bonus.
 * - /verify issues a one-time token and instructs the user to open the static verify page (Netlify/Vercel)
 *   which will redirect the browser to this bot's /device endpoint. The /device endpoint registers deviceHash.
 * - If a deviceHash collision is detected, the newly linking user is auto-banned and admins are notified.
 *
 * IMPORTANT: Replace these placeholders below with your real values:
 *   BOT_TOKEN, ADMIN_IDS, FORCE_CHANNEL, VERIFY_SITE_URL
 *
 * Files that are part of the project:
 * - index.js         (this file)
 * - xrocket.js       (XRocket integration)  <-- unchanged except kept here for completeness
 * - storage.js       (lowdb helpers)         <-- updated: includes pending token helpers
 * - admin.js         (admin commands)        <-- unchanged
 * - package.json     (dependencies)
 *
 * Start: `npm install` then `node index.js`
 */

const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');
const http = require('http');
const url = require('url');

const storage = require('./storage');
const xrocket = require('./xrocket');
const admin = require('./admin');

// ---------------------------
// CONFIG (hard-coded as requested)
// ---------------------------
const BOT_TOKEN = '8169992260:AAGmsEFpruItGAouT1wCmbVwBK1NjQTp0uU'; // <-- Replace with your bot token
const ADMIN_IDS = [8448744863]; // <-- Replace with actual admin Telegram numeric IDs
const FORCE_CHANNEL = '@fflemcy'; // <-- Replace with your channel username (eg @mychannel)
const VERIFY_SITE_URL = 'https://verifygo.netlify.app'; // <-- Replace with your static verify page URL (Netlify/Vercel)
const NEW_USER_BONUS = 0.005;
const REFERRAL_REWARD = 0.04;
const TASK_REWARD = 0.025;
const MIN_WITHDRAWAL = 0.2;

if (BOT_TOKEN === 'REPLACE_WITH_YOUR_TELEGRAM_BOT_TOKEN') {
  console.error('Please set BOT_TOKEN in index.js to your bot token.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------------------------
// Helpers
// ---------------------------
function computeDeviceHash(userAgent, ip) {
  const ipParts = (ip || '').split('.').slice(0, 2).join('.');
  const raw = `${userAgent || ''}|${ipParts}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function isMember(telegramId) {
  try {
    const info = await bot.telegram.getChatMember(FORCE_CHANNEL, telegramId);
    const status = info && info.status;
    return ['creator', 'administrator', 'member'].includes(status);
  } catch (e) {
    // Bot may not be admin or FORCE_CHANNEL may be wrong; treat as not a member
    console.log('isMember check error:', e.message);
    return false;
  }
}

async function ensureNewUserBonusAndReferral(ctx, refCode) {
  const tgId = String(ctx.from.id);
  let user = storage.getUser(tgId);

  if (user && user.isBanned) {
    await ctx.reply('Your account is banned.');
    return;
  }

  if (!user) {
    storage.createUser(tgId, {
      balance: 0,
      wallet: '',
      referrals: 0,
      deviceHash: '',
      isBanned: false,
      bonusClaimed: false,
      pendingDeviceToken: ''
    });
    user = storage.getUser(tgId);
  }

  // Grant bonus only if user is member AND has been verified (deviceHash present)
  const memberOk = await isMember(ctx.from.id);
  const verified = !!user.deviceHash;

  if (!user.bonusClaimed && memberOk && verified) {
    user.balance = Number((user.balance + NEW_USER_BONUS).toFixed(6));
    user.bonusClaimed = true;
    storage.updateUser(tgId, user);
    await ctx.reply(`Welcome! You've received a new user bonus of ${NEW_USER_BONUS} TON.`);
  } else if (!memberOk || !verified) {
    // Provide instructions: must verify device and join channel
    const must = [];
    if (!verified) must.push('verify your device using /verify');
    if (!memberOk) must.push(`join ${FORCE_CHANNEL}`);
    await ctx.reply(`To complete registration and receive the new-user bonus you must: ${must.join(' and ')}. Use /verify then join the channel, then send /start again.`);
    return;
  } else {
    await ctx.reply('Welcome back!');
  }

  // Handle referral: only if refCode provided and user not yet referred and user is member and verified
  if (refCode) {
    const refId = String(refCode);
    if (refId !== tgId) {
      const refUser = storage.getUser(refId);
      if (refUser && memberOk && verified) {
        if (!user.referredBy) {
          user.referredBy = refId;
          storage.updateUser(tgId, user);

          // Pay referrer: try XRocket if they have wallet and XRocket has balance, otherwise credit their balance
          if (refUser.wallet) {
            try {
              const botBalance = await xrocket.checkBalance();
              if (botBalance >= REFERRAL_REWARD) {
                const tx = await xrocket.sendTON(refId, REFERRAL_REWARD, refUser.wallet);
                await ctx.telegram.sendMessage(refId, `You earned a referral reward of ${REFERRAL_REWARD} TON. Transaction: ${tx || 'unknown'}`);
              } else {
                refUser.balance = Number((refUser.balance + REFERRAL_REWARD).toFixed(6));
                storage.updateUser(refId, refUser);
                await ctx.telegram.sendMessage(refId, `You were credited ${REFERRAL_REWARD} TON to your balance (XRocket low).`);
              }
            } catch (err) {
              console.error('Referral XRocket error:', err.message);
              refUser.balance = Number((refUser.balance + REFERRAL_REWARD).toFixed(6));
              storage.updateUser(refId, refUser);
              await ctx.telegram.sendMessage(refId, `You were credited ${REFERRAL_REWARD} TON to your balance.`);
            }
          } else {
            refUser.balance = Number((refUser.balance + REFERRAL_REWARD).toFixed(6));
            storage.updateUser(refId, refUser);
            await ctx.telegram.sendMessage(refId, `You were credited ${REFERRAL_REWARD} TON to your balance (no wallet).`);
          }

          refUser.referrals = (refUser.referrals || 0) + 1;
          storage.updateUser(refId, refUser);
        }
      }
    }
  }
}

// ---------------------------
// Middleware: STRICT membership + verification enforcement
//
// Rules:
// - Admins bypass middleware.
// - For non-admins: 
//   - Only allow /start (to see instructions) and /verify (to get verification link)
//   - Block ALL other commands including inline buttons, menus, etc.
//   - User must be member of FORCE_CHANNEL AND must be verified (deviceHash present) to access ANY other functionality.
// ---------------------------
bot.use(async (ctx, next) => {
  let userId = null;
  if (ctx.from && ctx.from.id) userId = ctx.from.id;
  else if (ctx.message && ctx.message.from && ctx.message.from.id) userId = ctx.message.from.id;
  else if (ctx.callbackQuery && ctx.callbackQuery.from && ctx.callbackQuery.from.id) userId = ctx.callbackQuery.from.id;

  if (!userId) return next();

  if (ADMIN_IDS.map(String).includes(String(userId))) {
    return next();
  }

  // Check if user exists and is banned
  const user = storage.getUser(String(userId)) || {};
  if (user.isBanned) {
    try {
      await ctx.reply('Your account is banned.');
    } catch (e) {}
    return;
  }

  // Get membership and verification status
  const member = await isMember(userId);
  const verified = !!user.deviceHash;

  // Determine command/action type
  let isStartCmd = false;
  let isVerifyCmd = false;
  
  if (ctx.updateType === 'message' && ctx.message && typeof ctx.message.text === 'string') {
    const text = ctx.message.text.trim();
    isStartCmd = text.startsWith('/start');
    isVerifyCmd = text.startsWith('/verify');
  }
  
  // Allow ONLY /start and /verify if not fully verified
  if (!member || !verified) {
    if (isStartCmd || isVerifyCmd) {
      // For /start, show only verification/channel instructions, not the full menu
      if (isStartCmd) {
        const must = [];
        if (!verified) must.push('verify your device using /verify');
        if (!member) must.push(`join ${FORCE_CHANNEL}`);
        
        await ctx.reply(
          `Welcome! To use this bot, you must:\n\n` +
          `1. ${must.join('\n2. ')}\n\n` +
          `Use /verify to get a verification link, then join ${FORCE_CHANNEL}, then send /start again.`
        );
        return; // Don't proceed to the actual /start handler
      }
      return next(); // Allow /verify to proceed
    }
    
    // Block ALL other commands and actions
    const parts = [];
    if (!verified) parts.push('verify your device using /verify');
    if (!member) parts.push(`join ${FORCE_CHANNEL}`);
    const hint = `Access denied. You must ${parts.join(' and ')} to use the bot.`;
    
    try {
      // For callback queries (inline buttons), show alert
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(hint, { show_alert: true });
      } else {
        await ctx.reply(hint);
      }
    } catch (e) {}
    return;
  }

  // User is fully verified and joined channel - allow all commands
  return next();
});

// ---------------------------
// Commands
// ---------------------------
bot.start(async (ctx) => {
  // /start or /start <ref_code>
  const parts = ctx.message.text ? ctx.message.text.split(' ') : [];
  const refCode = parts[1] ? parts[1].trim() : null;

  // First ensure user exists
  const uid = String(ctx.from.id);
  let user = storage.getUser(uid);
  if (!user) {
    storage.createUser(uid, {
      balance: 0,
      wallet: '',
      referrals: 0,
      deviceHash: '',
      isBanned: false,
      bonusClaimed: false,
      pendingDeviceToken: ''
    });
    user = storage.getUser(uid);
  }

  // Check if user is banned
  if (user.isBanned) {
    await ctx.reply('Your account is banned.');
    return;
  }

  // Check membership and verification
  const member = await isMember(ctx.from.id);
  const verified = !!user.deviceHash;

  // If not fully verified, middleware should handle this, but add extra safety
  if (!member || !verified) {
    const must = [];
    if (!verified) must.push('verify your device using /verify');
    if (!member) must.push(`join ${FORCE_CHANNEL}`);
    
    await ctx.reply(
      `To use the bot, you must:\n\n` +
      `1. ${must.join('\n2. ')}\n\n` +
      `Use /verify to get a verification link, then join ${FORCE_CHANNEL}, then send /start again.`
    );
    return;
  }

  // User is fully verified - process bonus and referrals
  await ensureNewUserBonusAndReferral(ctx, refCode);

  // Show full menu
  await ctx.reply(
    `Hi ${ctx.from.first_name}!\n\nCommands:\n/verify - verify this device\n/wallet <address>\n/tasks\n/submit <task_id> (attach photo)\n/balance\n/withdraw\n/referralcode`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Tasks', callback_data: 'show_tasks' }, { text: 'Balance', callback_data: 'show_balance' }],
          [{ text: 'Verify', callback_data: 'verify' }]
        ]
      }
    }
  );
});

bot.command('verify', async (ctx) => {
  const uid = String(ctx.from.id);
  const user = storage.getUser(uid) || null;
  if (user && user.isBanned) return ctx.reply('Your account is banned.');

  // create user if not exists
  if (!user) {
    storage.createUser(uid, {
      balance: 0,
      wallet: '',
      referrals: 0,
      deviceHash: '',
      isBanned: false,
      bonusClaimed: false,
      pendingDeviceToken: ''
    });
  }

  // generate one-time token and store it
  const token = crypto.randomBytes(20).toString('hex');
  storage.setPendingDeviceToken(uid, token);

  // build static verify page link (user should open this link in Telegram in-app browser)
  const link = `${VERIFY_SITE_URL}?token=${encodeURIComponent(token)}`;
  await ctx.reply(
    `Open this link in the Telegram in-app browser on the device you want to verify:\n\n${link}\n\nThe page will redirect to the bot to finish verification.`
  );
});

bot.command('wallet', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (!args[0]) {
    return ctx.reply('Usage: /wallet <TON_wallet_address>');
  }
  const wallet = args[0].trim();
  if (wallet.length < 8) return ctx.reply('Invalid wallet address.');

  const uid = String(ctx.from.id);
  const user = storage.getUser(uid);
  if (!user) {
    return ctx.reply('Please /start first.');
  }
  user.wallet = wallet;
  storage.updateUser(uid, user);
  await ctx.reply('Wallet saved.');
});

bot.command('setdevice', (ctx) => {
  return ctx.reply('Use /verify (recommended) to link this device. You will receive a link to open in your Telegram browser.');
});

bot.command('tasks', (ctx) => {
  const tasks = storage.getTasks();
  if (!tasks || tasks.length === 0) {
    return ctx.reply('No tasks available right now.');
  }
  let text = 'Available tasks:\n';
  for (const t of tasks) {
    text += `ID: ${t.id} - ${t.text} (Reward: ${t.reward} TON)\n`;
  }
  ctx.reply(text);
});

bot.command('submit', async (ctx) => {
  // /submit <task_id> with photo attached or reply to photo
  const args = ctx.message.text.split(' ').slice(1);
  const taskId = Number(args[0]);
  if (!taskId) return ctx.reply('Usage: /submit <task_id> (attach screenshot/photo)');

  const photos = ctx.message.photo;
  let fileId = null;
  if (photos && photos.length > 0) {
    fileId = photos[photos.length - 1].file_id;
  } else if (ctx.message.reply_to_message && ctx.message.reply_to_message.photo) {
    const rpPhotos = ctx.message.reply_to_message.photo;
    fileId = rpPhotos[rpPhotos.length - 1].file_id;
  } else {
    return ctx.reply('Please attach a screenshot/photo with /submit or reply to a photo with /submit <task_id>.');
  }

  const task = storage.getTask(taskId);
  if (!task) return ctx.reply('Task not found.');

  const submission = storage.addSubmission({
    userId: String(ctx.from.id),
    taskId: taskId,
    photoFileId: fileId,
    status: 'pending',
    createdAt: Date.now()
  });

  const inline = Markup.inlineKeyboard([
    Markup.button.callback('Approve', `approve_${submission.id}`),
    Markup.button.callback('Reject', `reject_${submission.id}`)
  ]);

  for (const aid of ADMIN_IDS) {
    try {
      await ctx.telegram.sendPhoto(
        aid,
        fileId,
        {
          caption: `Submission ID: ${submission.id}\nUser: ${ctx.from.id}\nTask: ${task.text}`,
          ...inline
        }
      );
    } catch (e) {
      console.error('Error notifying admin:', e.message);
    }
  }

  await ctx.reply('Submission received. Wait for admin approval.');
});

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data) return;

  const fromId = String(ctx.from.id);
  
  // Check if user is verified before allowing any callback actions (except verify)
  const user = storage.getUser(fromId) || {};
  const member = await isMember(ctx.from.id);
  const verified = !!user.deviceHash;
  
  // Allow admins
  if (ADMIN_IDS.map(String).includes(fromId)) {
    // Admin callback logic remains the same...
  } else if (!member || !verified) {
    // Block unverified users from using ANY inline buttons
    await ctx.answerCbQuery('You must verify and join the channel first. Use /verify', { show_alert: true });
    return;
  }
  
  if (data.startsWith('approve_') || data.startsWith('reject_')) {
    const parts = data.split('_');
    const action = parts[0];
    const sid = Number(parts[1]);
    const sub = storage.getSubmission(sid);
    if (!sub) {
      await ctx.answerCbQuery('Submission not found');
      return;
    }
    if (sub.status !== 'pending') {
      await ctx.answerCbQuery('Already processed.');
      return;
    }

    if (action === 'approve') {
      const user = storage.getUser(sub.userId);
      if (!user) {
        await ctx.answerCbQuery('User not found.');
        return;
      }
      user.balance = Number((user.balance + TASK_REWARD).toFixed(6));
      storage.updateUser(sub.userId, user);

      sub.status = 'approved';
      sub.processedBy = fromId;
      sub.processedAt = Date.now();
      storage.updateSubmission(sub);

      try {
        await bot.telegram.sendMessage(sub.userId, `Your submission #${sid} was approved. +${TASK_REWARD} TON added to your balance.`);
      } catch (e) {}

      await ctx.editMessageCaption(`Submission ID: ${sub.id}\nUser: ${sub.userId}\nTask ID: ${sub.taskId}\nStatus: approved`);
      await ctx.answerCbQuery('Approved.');
    } else {
      sub.status = 'rejected';
      sub.processedBy = fromId;
      sub.processedAt = Date.now();
      storage.updateSubmission(sub);

      try {
        await bot.telegram.sendMessage(sub.userId, `Your submission #${sid} was rejected by admin.`);
      } catch (e) {}
      await ctx.editMessageCaption(`Submission ID: ${sub.id}\nUser: ${sub.userId}\nTask ID: ${sub.taskId}\nStatus: rejected`);
      await ctx.answerCbQuery('Rejected.');
    }
  } else if (data === 'show_tasks') {
    const tasks = storage.getTasks();
    let text = 'Available tasks:\n';
    for (const t of tasks) text += `ID: ${t.id} - ${t.text} (Reward: ${t.reward} TON)\n`;
    await ctx.answerCbQuery();
    await ctx.reply(text);
  } else if (data === 'show_balance') {
    const u = storage.getUser(String(ctx.from.id)) || { balance: 0 };
    await ctx.answerCbQuery();
    await ctx.reply(`Balance: ${u.balance || 0} TON`);
  } else if (data === 'verify') {
    await ctx.answerCbQuery('Use /verify to get a verification link.');
  } else {
    await ctx.answerCbQuery();
  }
});

bot.command('balance', (ctx) => {
  const u = storage.getUser(String(ctx.from.id)) || { balance: 0 };
  ctx.reply(`Your balance: ${u.balance || 0} TON`);
});

bot.command('referralcode', async (ctx) => {
  const me = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?start=${ctx.from.id}`;
  ctx.reply(`Share this referral link: ${link}`);
});

bot.command('withdraw', async (ctx) => {
  const uid = String(ctx.from.id);
  const user = storage.getUser(uid);
  if (!user) return ctx.reply('Please /start first.');
  if (user.isBanned) return ctx.reply('Your account is banned.');

  if (!user.wallet) return ctx.reply('Set your TON wallet first with /wallet <address>.');

  if ((user.balance || 0) < MIN_WITHDRAWAL) {
    return ctx.reply(`Minimum withdrawal is ${MIN_WITHDRAWAL} TON. Your balance: ${user.balance || 0}`);
  }

  try {
    const botBalance = await xrocket.checkBalance();
    if (botBalance < user.balance) {
      return ctx.reply('Bot XRocket balance is insufficient to process your withdrawal. Try later.');
    }

    const amount = Number(user.balance); // withdraw full amount
    const tx = await xrocket.sendTON(uid, amount, user.wallet);
    user.balance = 0;
    storage.updateUser(uid, user);

    await ctx.reply(`Withdrawal processed. TX: ${tx || 'unknown'}`);
  } catch (err) {
    console.error('Withdrawal error:', err.message);
    await ctx.reply(`Withdrawal failed: ${err.message}`);
  }
});

// Admin commands
admin.register(bot, { storage, xrocket, ADMIN_IDS, TASK_REWARD, REFERRAL_REWARD, MIN_WITHDRAWAL, FORCE_CHANNEL });

// ping
bot.command('ping', (ctx) => ctx.reply('pong'));

// launch bot
bot.launch().then(() => {
  console.log('Bot started.');
});

// ---------------------------
// /device endpoint (web server)
// - receives GET /device?token=...
// - computes deviceHash from UA + IP (x-forwarded-for preferred)
// - if deviceHash already used by different user -> ban new user and notify
// - else store deviceHash for user, clear pending token, notify success
// ---------------------------
const DEVICE_PORT = process.env.PORT || 3000;

const deviceServer = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname !== '/device') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const token = parsed.query && parsed.query.token;
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h3>Missing token</h3><p>Open the verification link from the bot.</p>');
      return;
    }

    const userId = storage.findUserByPendingToken(token);
    if (!userId) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h3>Invalid or expired token</h3><p>Please request a new verification link from the bot using /verify.</p>');
      return;
    }

    // Get client IP and UA
    const forwarded = req.headers['x-forwarded-for'];
    const ipRaw = forwarded ? forwarded.split(',')[0] : (req.socket && req.socket.remoteAddress) || '';
    const ip = (ipRaw || '').replace(/^::ffff:/, '');
    const ua = req.headers['user-agent'] || '';

    const deviceHash = computeDeviceHash(ua, ip);

    const otherUid = storage.findUserByDeviceHash(deviceHash);

    if (otherUid && otherUid !== userId) {
      // auto-ban newly linking user
      const u = storage.getUser(userId) || {};
      u.deviceHash = deviceHash;
      u.isBanned = true;
      storage.updateUser(userId, u);
      storage.clearPendingDeviceToken(userId);

      // notify the affected user
      try {
        await bot.telegram.sendMessage(userId, 'Your account has been banned for looting/cheating: this device is already linked to another account.');
      } catch (e) {}

      // notify admins
      for (const aid of ADMIN_IDS) {
        try {
          await bot.telegram.sendMessage(aid, `Anti-cheat: User ${userId} attempted to verify a device already used by ${otherUid}. New account auto-banned.`);
        } catch (e) {}
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h3>Device linked</h3><p>This device is already used by another account. Your account has been flagged/banned. Return to Telegram.</p>`);
      return;
    }

    // success: store deviceHash
    const user = storage.getUser(userId) || {};
    user.deviceHash = deviceHash;
    user.isBanned = user.isBanned || false;
    storage.updateUser(userId, user);
    storage.clearPendingDeviceToken(userId);

    // notify user: they still must join the channel and then run /start to finalize
    try {
      await bot.telegram.sendMessage(userId, 'Device verified successfully. Now join the required channel and then send /start to complete registration and receive your bonus (if eligible).');
    } catch (e) {}

    // notify admins optionally
    for (const aid of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(aid, `Device verification: user ${userId} linked a device (hash ${deviceHash}).`);
      } catch (e) {}
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h3>Device linked</h3><p>Device verification successful. Return to Telegram, join the required channel, and then send /start to complete registration.</p>');
  } catch (err) {
    console.error('/device endpoint error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error');
  }
});

deviceServer.listen(DEVICE_PORT, () => {
  console.log(`Device verification server listening on port ${DEVICE_PORT}`);
});