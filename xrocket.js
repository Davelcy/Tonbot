/**
 * xrocket.js - Handle XRocket payments
 *
 * Uses axios to call XRocket API.
 *
 * API Token included as requested.
 */

const axios = require('axios');

const XRocketToken = 'e499151c3dbeda1ff2f93e471';
const API_BASE = 'https://pay.xrocket.tg/api';

async function sendTON(userId, amount, walletAddress) {
  try {
    const body = {
      token: XRocketToken,
      to: walletAddress,
      amount: Number(amount)
    };
    const resp = await axios.post(`${API_BASE}/transfer`, body, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'XRocket-Telegraf-Bot/1.0'
      }
    });
    const data = resp.data || {};
    const txId =
      data.result?.tx?.id ||
      data.result?.txId ||
      data.tx_id ||
      data.id ||
      (data.result && JSON.stringify(data.result)) ||
      JSON.stringify(data);
    return txId;
  } catch (err) {
    throw new Error(err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message);
  }
}

async function checkBalance() {
  try {
    const body = { token: XRocketToken };
    const resp = await axios.post(`${API_BASE}/get_balance`, body, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    const data = resp.data || {};
    const balance = data.result?.balance || data.balance || data.result?.amount || 0;
    return Number(balance || 0);
  } catch (err) {
    console.error('XRocket balance check failed:', err.message);
    throw new Error('XRocket balance check failed');
  }
}

module.exports = {
  sendTON,
  checkBalance
};