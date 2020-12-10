require('dotenv').config()
const env = process.env;
const IRIS_PRIVATE_KEY = JSON.parse(env.IRIS_PRIVATE_KEY || 'null');
const GUN_OPTS = JSON.parse(env.GUN_OPTS || 'null');

const fetchBase = require('node-fetch');

const fetch = (url, opts, wait = 20000) => {
  return new Promise(resolve => {
    fetchBase(url, opts)
    .then(resolve)
    .catch(() => {
      setTimeout(() => {
        resolve(fetch(url, opts, wait));
      }, wait);
    });
  });
}

const Gun = require('gun');
require('gun/sea');
const iris = require('iris-lib/dist/iris.js');

const express = require('express');
const app = express();
const INCOMING_HTTP_PORT = 8082;
const ELECTRUM_NOTIFY_URL = `http://iris-store:${INCOMING_HTTP_PORT}/electrum_notify`;
const ELECTRUM_URL = `http://${env.ELECTRUM_USER}:${env.ELECTRUM_PASSWORD}@electrum:7000`;
const EXCHANGE_RATE_DISPARITY_TOLERANCE = 1.2;

const channels = {};

const publicState = new Gun(GUN_OPTS);
iris.Channel.initUser(publicState, IRIS_PRIVATE_KEY);

const checkIfPaid = async (addr, from) => {
  try {
    const r = await fetchBase(ELECTRUM_URL, {
      method: 'POST',
      body: `{"id":"1","method":"getaddressbalance", "params": ["${addr}"]}`,
      headers: {
          'Content-Type': 'application/json',
        }
    });
    const t = await r.json();
    if (t.result && t.result.confirmed + t.result.unconfirmed > 0) {
      getChannel(from).send('thanks for the payment! ' + t.result.confirmed + t.result.unconfirmed);
      const paid = await Gun.SEA.encrypt(true, IRIS_PRIVATE_KEY);
      // TODO save paid status to the correct order
    }
    return t;

  } catch (e) {
    console.error(e);
  }
}

function getChannel(id) {
  return channels[id] || new iris.Channel({gun: publicState, key: IRIS_PRIVATE_KEY, participants: id});
}

const monitorForPayment = (address, from) => {
  const iv = setInterval(async () => {
    const paid = await checkIfPaid(address, from);
    if (paid && paid.result && paid.result.confirmed + paid.result.unconfirmed > 0) {
      clearInterval(iv);
    }
  }, 10000);
}

app.get('/electrum_notify/:addr', async (req, res) => {
  const addr = req.params.addr;
  console.log('/electrum_notify', addr);
  if (addr) {
    checkIfPaid(addr);
  }
  res.send('');
});

app.listen(INCOMING_HTTP_PORT);

let latestKraken, latestBitstamp, ourExchangeRate;
function saveAverageRate() {
  if (latestKraken && latestBitstamp) {
    if (Math.abs(latestKraken.time - latestBitstamp.time) < 60 * 1000 * 60) {
      const lower = Math.min(latestKraken.rate, latestBitstamp.rate);
      const higher = Math.max(latestKraken.rate, latestBitstamp.rate);
      if (higher / lower < EXCHANGE_RATE_DISPARITY_TOLERANCE) {
        ourExchangeRate = ((higher + lower) / 2).toFixed(2);
        publicState.user().get('store').get('exchangeRate').get('btcusd').put(ourExchangeRate.toString());
      } else {
        publicState.user().get('store').get('exchangeRate').get('btcusd').put(null);
        console.error(`warning: bitstamp exchange rate (${latestBitstamp.rate}) and kraken exchange rate (${latestKraken.rate}) diverge by more than ${EXCHANGE_RATE_DISPARITY_TOLERANCE}`);
      }
    } else {
      console.error(`bitstamp ${latestBitstamp.time} or kraken ${latestKraken.time} exchange rate expired`);
    }
  }
}
async function getExchangeRate() {
  fetchBase('https://api.kraken.com/0/public/Ticker?pair=XBTUSD').then(async res => {
    const r = await res.json();
    const p = r && r.result && r.result.XXBTZUSD && r.result.XXBTZUSD.p;
    if (p && p.length === 2) {
      latestKraken = { rate: Number(p[1]), time: new Date()};
      saveAverageRate();
    }
  }).catch();
  fetchBase('https://www.bitstamp.net/api/ticker/').then(async res => {
    const r = await res.json();
    const p = r && r.vwap;
    if (p) {
      latestBitstamp = { rate: Number(p), time: new Date()};
      saveAverageRate();
    }
  }).catch();
}

getExchangeRate();
setInterval(getExchangeRate, 60000);

const orders = {};
publicState.user().get('orders').map().on(async (v,orderId) => {
  let order = orders[orderId];
  if (!v || (order && order.msg && order.msg.text && order.msg.text.length > 1)) return;
  orders[orderId] = {};
  if (typeof v === 'string') {
    order = {msg: v, from: null};
    publicState.user().get('orders').get(orderId).put(order); // migrate
    v = order;
  } else {
    order = Object.assign({}, order, v);
  }
  const msg = v.msg && await Gun.SEA.decrypt(v.msg, IRIS_PRIVATE_KEY);
  const paid = v.paid && await Gun.SEA.decrypt(v.paid, IRIS_PRIVATE_KEY);
  const address = v.address && await Gun.SEA.decrypt(v.address, IRIS_PRIVATE_KEY);
  const from = v.from && await Gun.SEA.decrypt(v.from, IRIS_PRIVATE_KEY);
  const usdPrice = v.from && await Gun.SEA.decrypt(v.usdPrice, IRIS_PRIVATE_KEY);
  orders[orderId] = {msg, paid, address, from, usdPrice};
  if (!usdPrice) {
    getUsdPrice(orderId);
  }
  if (!address) {
    getPaymentAddress(getChannel(from), orderId);
  } else if (!paid) {
    monitorForPayment(address, from);
  }
});

async function getUsdPrice(orderId) {
  const order = orders[orderId];
  if (order && order.msg && order.msg.text && order.msg.text.length > 1) {
    const msg = order.msg.text;
    const start = msg.indexOf('{');
    let n = 1;
    let i;
    for (i = start + 1; i < msg.length; i++) {
      if (msg[i] === '{') {
        n++;
      } else if (msg[i] === '}') {
        n--;
      }
      if (n === 0) {
        i++;
        break;
      }
    }
    const slice = msg.slice(start, i);
    try {
      const orderItems = JSON.parse(slice);
      let usdPrice = 0;
      const keys = Object.keys(orderItems);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const price = await publicState.user().get('store').get('products').get(k).get('price').once();
        usdPrice += (Number(price)) || 0;
      }
      const encUsdPrice = await Gun.SEA.encrypt(usdPrice.toString(), IRIS_PRIVATE_KEY);
      console.log('usdPrice', usdPrice.toString(), encUsdPrice);
      publicState.user().get('orders').get(orderId).get('usdPrice').put(encUsdPrice);
      orders[orderId].usdPrice = usdPrice;
    } catch (e) {
      console.error('json parsing failed', e, slice);
    }
  } else {
    console.error('order', orderId, 'not found or incomplete:', order);
  }
}

const getPaymentAddress = async (channel, orderId) => {
  try {
    const res = await fetchBase(ELECTRUM_URL, {
      method: 'POST',
      body: '{"id":"1","method":"addrequest","params":{"amount": "0.0001", "force": "true"}}',
      headers: {
          'Content-Type': 'application/json',
        }
    });
    const json = await res.json();
    const address = json.result && json.result.address;
    const usdPrice = orders[orderId] && Number(orders[orderId].usdPrice);
    if (address && usdPrice) {
      const btcPrice = (usdPrice / ourExchangeRate).toFixed(8);
      const encBtcPrice = await Gun.SEA.encrypt(btcPrice.toString(), IRIS_PRIVATE_KEY);
      const encAddress = await Gun.SEA.encrypt(address, IRIS_PRIVATE_KEY);
      publicState.user().get('orders').get(orderId).get('address').put(encAddress);
      publicState.user().get('orders').get(orderId).get('btcPrice').put(encBtcPrice);
      channel.send(`please pay ${btcPrice} BTC to ${address}`);
      fetchBase(ELECTRUM_URL, {
        method: 'POST',
        body: `{"id":"1","method":"notify", params:["${address}", "${ELECTRUM_NOTIFY_URL}/${address}"]}`,
        headers: {
            'Content-Type': 'application/json',
          }
      }).catch(console.error);
      monitorForPayment(address, channel.getId());
    }
  } catch (e) {
    setTimeout(() => getPaymentAddress(channel, orderId), 10000);
    console.error(e);
  }
}

async function previouslySeen(id) {
  if (orders[id]) {
    return true;
  }
  orders[id] = {};
  const order = await publicState.user().get('orders').get(id).once();
  return !!order;
}

setTimeout(() => {
  iris.Channel.getChannels(publicState, IRIS_PRIVATE_KEY, channel => {
    channel.getMessages(async (m, info) => {
      // printMessage(m, info);
      if (m.order) {
        const orderId = await iris.util.getHash(JSON.stringify(m) + IRIS_PRIVATE_KEY.priv);
        if (!(await previouslySeen(orderId))) {
          const paid = await Gun.SEA.encrypt(false, IRIS_PRIVATE_KEY);
          const msg = await Gun.SEA.encrypt(m, IRIS_PRIVATE_KEY);
          const from = await Gun.SEA.encrypt(channel.getId(), IRIS_PRIVATE_KEY);
          const order = {msg: m, paid: false, from: channel.getId(), time: new Date().toISOString()};
          orders[orderId] = order;
          publicState.user().get('orders').get(orderId).put(order);
          console.log('received new order', m);
          getUsdPrice(orderId);
          getPaymentAddress(channel, orderId);
        }
      }
    });
  });
}, 1000);

function printMessage(msg, info) {
  console.log(`[${new Date(msg.time).toLocaleString()}] ${info.from.slice(0,8)}: ${msg.text}`)
}
