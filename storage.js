/**
 * storage.js - Simple JSON database using lowdb (FileSync)
 *
 * Data shape:
 * {
 *   "users": {
 *     "12345": {
 *       "balance": 0.15,
 *       "wallet": "TON_wallet_address",
 *       "referrals": 2,
 *       "deviceHash": "abc123",
 *       "isBanned": false,
 *       "bonusClaimed": false,
 *       "pendingDeviceToken": "abcdef"
 *     }
 *   },
 *   "tasks": [ { "id": 1, "text": "Follow on Twitter", "reward": 0.025 } ],
 *   "submissions": [ { "id": 1, ... } ]
 * }
 */

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('db.json');
const db = low(adapter);

// defaults
db.defaults({ users: {}, tasks: [], submissions: [], nextTaskId: 1, nextSubmissionId: 1 }).write();

function getUser(id) {
  return db.get('users').get(id).value();
}

function createUser(id, data) {
  db.get('users').set(id, data).write();
  return getUser(id);
}

function updateUser(id, data) {
  db.get('users').set(id, data).write();
}

function findUserByDeviceHash(hash) {
  if (!hash) return null;
  const all = db.get('users').value() || {};
  for (const k of Object.keys(all)) {
    if (all[k] && all[k].deviceHash === hash) return k;
  }
  return null;
}

function getTasks() {
  return db.get('tasks').value();
}

function getTask(id) {
  return db.get('tasks').find({ id }).value();
}

function addTask(text, reward) {
  const id = db.get('nextTaskId').value();
  db.get('tasks').push({ id, text, reward }).write();
  db.update('nextTaskId', n => n + 1).write();
  return db.get('tasks').find({ id }).value();
}

function addSubmission(sub) {
  const id = db.get('nextSubmissionId').value();
  const obj = Object.assign({ id }, sub);
  db.get('submissions').push(obj).write();
  db.update('nextSubmissionId', n => n + 1).write();
  return obj;
}

function getSubmission(id) {
  return db.get('submissions').find({ id }).value();
}

function updateSubmission(sub) {
  const id = sub.id;
  db.get('submissions').find({ id }).assign(sub).write();
}

function getAllUsers() {
  return db.get('users').value();
}

// --- pendingDeviceToken helpers ---
function setPendingDeviceToken(userId, token) {
  const u = getUser(userId) || {};
  u.pendingDeviceToken = token;
  updateUser(userId, u);
}

function findUserByPendingToken(token) {
  if (!token) return null;
  const all = db.get('users').value() || {};
  for (const k of Object.keys(all)) {
    if (all[k] && all[k].pendingDeviceToken === token) return k;
  }
  return null;
}

function clearPendingDeviceToken(userId) {
  const u = getUser(userId) || {};
  if (u.pendingDeviceToken) {
    delete u.pendingDeviceToken;
    updateUser(userId, u);
  }
}

module.exports = {
  getUser,
  createUser,
  updateUser,
  findUserByDeviceHash,
  getTasks,
  getTask,
  addTask,
  addSubmission,
  getSubmission,
  updateSubmission,
  getAllUsers,
  setPendingDeviceToken,
  findUserByPendingToken,
  clearPendingDeviceToken
};