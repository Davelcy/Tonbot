/**
 * admin.js - Admin commands and handlers
 *
 * Admin commands supported:
 * - /admin broadcast <text>
 * - /admin addtask <desc>
 * - /admin ban <user_id>
 * - /admin approve <submission_id>
 *
 * This file exports register(bot, deps) to wire handlers into the main bot.
 */

const { Markup } = require('telegraf');

function register(bot, deps) {
  const { storage, xrocket, ADMIN_IDS, TASK_REWARD, REFERRAL_REWARD, MIN_WITHDRAWAL } = deps;

  // Only allow admins
  bot.hears(/^\/admin\s+(.+)$/i, async (ctx) => {
    const from = String(ctx.from.id);
    if (!ADMIN_IDS.map(String).includes(from)) return ctx.reply('Unauthorized.');

    const args = ctx.match[1].trim();
    if (args.startsWith('broadcast ')) {
      const msg = args.slice('broadcast '.length).trim();
      const users = storage.getAllUsers();
      const ids = Object.keys(users);
      let sent = 0;
      for (const uid of ids) {
        try {
          await ctx.telegram.sendMessage(uid, `Broadcast from admin:\n\n${msg}`);
          sent++;
        } catch (e) {
          // ignore
        }
      }
      await ctx.reply(`Broadcast sent to ${sent} users (attempted ${ids.length}).`);
    } else if (args.startsWith('addtask ')) {
      const desc = args.slice('addtask '.length).trim();
      if (!desc) return ctx.reply('Usage: /admin addtask <description>');
      const task = storage.addTask(desc, TASK_REWARD || 0.025);
      await ctx.reply(`Task added. ID: ${task.id}`);
    } else if (args.startsWith('ban ')) {
      const uid = args.slice('ban '.length).trim();
      if (!uid) return ctx.reply('Usage: /admin ban <user_id>');
      const user = storage.getUser(String(uid));
      if (!user) return ctx.reply('User not found.');
      user.isBanned = true;
      storage.updateUser(String(uid), user);
      await ctx.reply(`User ${uid} banned.`);
    } else if (args.startsWith('approve ')) {
      // CLI fallback approve command
      const sid = Number(args.slice('approve '.length).trim());
      const sub = storage.getSubmission(sid);
      if (!sub) return ctx.reply('Submission not found.');
      if (sub.status !== 'pending') return ctx.reply('Submission already processed.');
      // approve
      const user = storage.getUser(sub.userId);
      if (!user) return ctx.reply('Submission user not found.');
      user.balance = Number((user.balance + TASK_REWARD).toFixed(6));
      storage.updateUser(sub.userId, user);
      sub.status = 'approved';
      sub.processedBy = String(ctx.from.id);
      sub.processedAt = Date.now();
      storage.updateSubmission(sub);
      try {
        await ctx.telegram.sendMessage(sub.userId, `Your submission #${sid} was approved. +${TASK_REWARD} TON added.`);
      } catch (e) {}
      await ctx.reply('Submission approved.');
    } else {
      await ctx.reply('Admin commands:\n/admin broadcast <text>\n/admin addtask <desc>\n/admin ban <user_id>\n/admin approve <submission_id>');
    }
  });
}

module.exports = { register };