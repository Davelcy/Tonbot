 /**
 * index.js - Complete Telegram bot
 *
 * Features implemented (as requested):
 * - Force channel join + device verification required before getting access and bonus
 * - /verify issues one-time token; user opens VERIFY_SITE_URL which redirects to /device?token=...
 * - /device endpoint registers deviceHash (IP + UA) and auto-bans on collision
 * - /start grants NEW_USER_BONUS only if user is member of FORCE_CHANNEL and device verified
 * - Referral reward handling
 * - Task system with admin inline approve/reject
 * - Withdrawal via XRocket (/withdraw), minimum enforced
 * - Anti-multi-account via deviceHash
 * - Admin panel via admin.js
 *
 * IMPORTANT: Replace placeholders below:
 * - BOT_TOKEN
 * - ADMIN_IDS array
 * - FORCE_CHANNEL (channel username like @channel)
 * - VERIFY_SITE_URL (static verify page URL on Netlify/Vercel)
 *
 * Keep other files (storage.js, xrocket.js, admin.js, package.json) as provided.
 */

const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');
const http = require('http');
const url = require('url');

const storage = require('./storage'); // expects helpers described before
const xrocket = require('./xrocket');
const admin = require('./admin');

// ---------------------------
// CONFIG - replace these values
// ---------------------------
const BOT_TOKEN = 'REPLACE_WITH_YOUR_TELEGRAM_BOT_TOKEN'; // <<--- put your bot token here
const ADMIN_IDS = [123456789]; // <<--- put admin numeric Telegram IDs here
const FORCE_CHANNEL = '@YourForceChannel'; // <<--- channel username, e.g. @mychannel
const VERIFY_SITE_URL = 'https://your-verify-site.example/verify'; // <<--- static page you deploy
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
  // use first two octets of IP + UA for a simple fingerprint
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
    // If bot can't check (not admin, wrong channel), treat as not a member
    console.log('isMember check error:', e.message);
    return false;
  }
}

// Grant bonus and handle referral if conditions met
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

  const memberOk = await isMember(ctx.from.id);
  const verified = !!user.deviceHash;

  if (!user.bonusClaimed && memberOk && verified) {
    user.balance = Number((user.balance + NEW_USER_BONUS).toFixed(6));
    user.bonusClaimed = true;
    storage.updateUser(tgId, user);
    await ctx.reply(`Welcome! You've received a new user bonus of ${NEW_USER_BONUS} TON.`);
  } else if (!memberOk || !verified) {
    const steps = [];
    if (!verified) steps.push('verify your device with /verify');
    if (!memberOk) steps.push(`join ${FORCE_CHANNEL}`);
    await ctx.reply(`To receive the new-user bonus you must ${steps.join(' and ')}. After that send /start again.`);
    return;
  } else {
    await ctx.reply('Welcome back!');
  }

  // Referral handling (only if member & verified)
  if (refCode) {
    const refId = String(refCode);
    if (refId !== tgId) {
      const refUser = storage.getUser(refId);
      if (refUser && memberOk && verified) {
        if (!user.referredBy) {
          user.referredBy = refId;
          storage.updateUser(tgId, user);

          // Try to pay via XRocket to referrer's wallet if set; otherwise credit balance
          if (refUser.wallet) {
            try {
              const botBalance = await xrocket.checkBalance();
              if (botBalance >= REFERRAL_REWARD) {
                const tx = await xrocket.sendTON(refId, REFERRAL_REWARD, refUser.wallet);
                await ctx.telegram.sendMessage(refId, `You earned a referral reward of ${REFERRAL_REWARD} TON. TX: ${tx || 'unknown'}`);
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
// Middleware: enforce verify + join BEFORE access (admins bypass)
// - allow /start and /verify for non-admins (so they can proceed)
// - for other commands, require both membership and verified deviceHash
// ---------------------------
bot.use(async (ctx, next) => {
  let userId = null;
  if (ctx.from && ctx.from.id) userId = ctx.from.id;
  else if (ctx.message && ctx.message.from && ctx.message.from.id) userId = ctx.message.from.id;
  else if (ctx.callbackQuery && ctx.callbackQuery.from && ctx.callbackQuery.from.id) userId = ctx.callbackQuery.from.id;

  if (!userId) return next();

  if (ADMIN_IDS.map(String).includes(String(userId))) {
    return next(); // admins bypass
  }

  const text = ctx.updateType === 'message' && ctx.message && typeof ctx.message.text === 'string' ? ctx.message.text.trim() : '';
  const isStart = text.startsWith('/start');
  const isVerify = text.startsWith('/verify');

  if (isStart || isVerify) return next();

  // For everything else require membership and verification
  const member = await isMember(userId);
  const u = storage.getUser(String(userId)) || {};
  const verified = !!u.deviceHash;

  if (!member || !verified) {
    const need = [];
    if (!verified) need.push('/verify');
    if (!member) need.push(`join ${FORCE_CHANNEL}`);
    try {
      await ctx.reply(`Access blocked. You must ${need.join(' and ')} to use the bot.`);
    } catch (e) {}
    return;
  }

  return next();
});

// ---------------------------
// Commands
// ---------------------------

bot.start(async (ctx) => {
  // parse optional ref code: /start <ref>
  const parts = ctx.message.text ? ctx.message.text.split(' ') : [];
  const refCode = parts[1] ? parts[1].trim() : null;

  await ensureNewUserBonusAndReferral(ctx, refCode);

  await ctx.reply(
    `Hi ${ctx.from.first_name}!\n\nAvailable commands:\n/verify - verify this device\n/wallet <address>\n/tasks\n/submit <task_id> (attach photo)\n/balance\n/withdraw\n/referralcode`
  );
});

bot.command('verify', async (ctx) => {
  const uid = String(ctx.from.id);
  const user = storage.getUser(uid) || null;
  if (user && user.isBanned) return ctx.reply('Your account is banned.');

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

  const token = crypto.randomBytes(20).toString('hex');
  storage.setPendingDeviceToken(uid, token);

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
  if (!user) return ctx.reply('Please /start first.');
  user.wallet = wallet;
  storage.updateUser(uid, user);
  await ctx.reply('Wallet saved.');
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
  // /submit <task_id> attach a photo or reply to a photo
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
  if (!ADMIN_IDS.map(String).includes(fromId)) {
    // non-admins clicking admin buttons get blocked
    return ctx.answerCbQuery('Only admins can use this.');
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

// Admin register
admin.register(bot, { storage, xrocket, ADMIN_IDS, TASK_REWARD, REFERRAL_REWARD, MIN_WITHDRAWAL, FORCE_CHANNEL });

// ping
bot.command('ping', (ctx) => ctx.reply('pong'));

// start bot
bot.launch().then(() => {
  console.log('Bot started.');
});

// ---------------------------
// Device endpoint server (/device?token=...)
// - This must be publicly reachable (DOMAIN/device) and preserve x-forwarded-for
// - The static VERIFY_SITE_URL should redirect browser to this URL with the token
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

    // get IP and UA
    const forwarded = req.headers['x-forwarded-for'];
    const ipRaw = forwarded ? forwarded.split(',')[0] : (req.socket && req.socket.remoteAddress) || '';
    const ip = (ipRaw || '').replace(/^::ffff:/, '');
    const ua = req.headers['user-agent'] || '';

    const deviceHash = computeDeviceHash(ua, ip);

    const otherUid = storage.findUserByDeviceHash(deviceHash);

    if (otherUid && otherUid !== userId) {
      // auto-ban new user linking this device
      const u = storage.getUser(userId) || {};
      u.deviceHash = deviceHash;
      u.isBanned = true;
      storage.updateUser(userId, u);
      storage.clearPendingDeviceToken(userId);

      try {
        await bot.telegram.sendMessage(userId, 'Your account has been banned for looting/cheating: this device is already linked to another account.');
      } catch (e) {}

      for (const aid of ADMIN_IDS) {
        try {
          await bot.telegram.sendMessage(aid, `Anti-cheat: User ${userId} attempted to verify a device already used by ${otherUid}. New account auto-banned.`);
        } catch (e) {}
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h3>Device linked</h3><p>This device is already used by another account. Your account has been flagged/banned. Return to Telegram.</p>`);
      return;
    }

    // success: save deviceHash
    const user = storage.getUser(userId) || {};
    user.deviceHash = deviceHash;
    user.isBanned = user.isBanned || false;
    storage.updateUser(userId, user);
    storage.clearPendingDeviceToken(userId);

    try {
      await bot.telegram.sendMessage(userId, 'Device verified successfully. Now join the required channel and then send /start to complete registration and receive your bonus (if eligible).');
    } catch (e) {}

    for (const aid of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(aid, `Device verification: user ${userId} linked a device (hash ${deviceHash}).`);
      } catch (e) {}
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h3>Device linked</h3><p>Your device was registered successfully. You can return to the Telegram app.</p>');
  } catch (err) {
    console.error('Device endpoint error:', err);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('<h3>Internal error</h3><p>Try again later.</p>');
  }
});

deviceServer.listen(DEVICE_PORT, () => {
  console.log(`Device endpoint listening on port ${DEVICE_PORT} at /device`);
});

// graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  deviceServer.close();
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  deviceServer.close();
});