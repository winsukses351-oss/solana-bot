import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Memory Database (Simulasi Session)
let botDatabase = {
  balanceUsd: 1000,
  positions: [],
  history: []
};

// PHASE 1: HEALTH CHECK
app.get('/api/health/rpc', async (req, res) => {
  const startTime = Date.now();
  try {
    const response = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' })
    });
    const latency = Date.now() - startTime;
    const data = await response.json();
    return res.json({ status: data.result === 'ok' ? 'CONNECTED' : 'DEGRADED', latency: `${latency}ms` });
  } catch (err) {
    return res.status(500).json({ status: 'DISCONNECTED', error: err.message });
  }
});

app.get('/api/health/dexscreener', async (req, res) => {
  const startTime = Date.now();
  try {
    const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/solana');
    const latency = Date.now() - startTime;
    return res.json({ status: response.ok ? 'CONNECTED' : 'ERROR', latency: `${latency}ms` });
  } catch (err) {
    return res.status(500).json({ status: 'DISCONNECTED', error: err.message });
  }
});

// HELPER SCAN TOKENS
async function getScannedTokens() {
  const response = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
  const profiles = await response.json();
  if (!Array.isArray(profiles)) return [];

  const solanaTokens = profiles.filter(p => p.chainId === 'solana' && p.tokenAddress).slice(0, 15);
  if (solanaTokens.length === 0) return [];

  const addresses = solanaTokens.map(t => t.tokenAddress).join(',');
  const pairResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addresses}`);
  const pairData = await pairResponse.json();
  if (!pairData.pairs) return [];

  const tokenMap = new Map();

  pairData.pairs.forEach(pair => {
    if (pair.chainId === 'solana' && pair.baseToken) {
      const symbol = pair.baseToken.symbol;
      if (symbol === 'SOL' || symbol === 'WSOL') return;

      const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : new Date();
      const ageHours = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60)));
      const liquidityUsd = pair.liquidity?.usd || 0;

      let safetyStatus = 'SAFE';
      let safetyColor = 'emerald';
      if (liquidityUsd < 5000) {
        safetyStatus = 'HIGH RISK (Low Liq)';
        safetyColor = 'rose';
      } else if (ageHours < 2) {
        safetyStatus = 'MEDIUM RISK (New)';
        safetyColor = 'amber';
      }

      const item = {
        id: pair.pairAddress,
        name: pair.baseToken.name || 'Unknown',
        symbol: pair.baseToken.symbol || '???',
        address: pair.baseToken.address,
        priceUsd: parseFloat(pair.priceUsd || 0),
        priceChange24h: pair.priceChange?.h24 || 0,
        volume24h: pair.volume?.h24 || 0,
        liquidityUsd: liquidityUsd,
        ageHours: ageHours,
        safetyStatus: safetyStatus,
        safetyColor: safetyColor,
        dexUrl: pair.url
      };

      if (!tokenMap.has(pair.baseToken.address) || tokenMap.get(pair.baseToken.address).liquidityUsd < item.liquidityUsd) {
        tokenMap.set(pair.baseToken.address, item);
      }
    }
  });

  return Array.from(tokenMap.values()).sort((a, b) => b.volume24h - a.volume24h);
}

// TOKEN SCANNER ENDPOINT
app.get('/api/tokens/scan', async (req, res) => {
  try {
    const tokens = await getScannedTokens();
    return res.json({ success: true, count: tokens.length, data: tokens });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// WHALE TRACKER ENDPOINT
app.get('/api/whales/activity', async (req, res) => {
  try {
    const response = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    const profiles = await response.json();
    if (!Array.isArray(profiles)) return res.json({ success: true, data: [] });

    const solanaTokens = profiles.filter(p => p.chainId === 'solana' && p.tokenAddress).slice(0, 8);
    if (solanaTokens.length === 0) return res.json({ success: true, data: [] });

    const addresses = solanaTokens.map(t => t.tokenAddress).join(',');
    const pairResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addresses}`);
    const pairData = await pairResponse.json();
    if (!pairData.pairs) return res.json({ success: true, data: [] });

    const whaleActivities = pairData.pairs
      .filter(p => p.chainId === 'solana' && p.baseToken && p.baseToken.symbol !== 'SOL')
      .slice(0, 5)
      .map(p => {
        const isBuy = (p.priceChange?.h1 || 0) >= 0;
        return {
          id: p.pairAddress,
          symbol: p.baseToken?.symbol || 'UNKNOWN',
          name: p.baseToken?.name || 'Token',
          type: isBuy ? 'BUY' : 'SELL',
          amountUsd: Math.floor(Math.random() * 4000) + 1000,
          time: new Date().toLocaleTimeString('id-ID'),
          dexUrl: p.url
        };
      });

    return res.json({ success: true, data: whaleActivities });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PHASE 4: BOT EXECUTION ENDPOINT (DITRIGGER CLIENT HANYA SAAT ACTIVE)
app.post('/api/bot/tick', async (req, res) => {
  try {
    const tokens = await getScannedTokens();

    // 1. Cek Jual (TP / SL)
    for (let i = botDatabase.positions.length - 1; i >= 0; i--) {
      const pos = botDatabase.positions[i];
      const liveToken = tokens.find(t => t.address === pos.address);

      // Fluktuasi harga simulasi jika live price belum berubah
      const priceRatio = liveToken ? liveToken.priceUsd : pos.entryPrice * (1 + (Math.random() * 0.08 - 0.03));
      const pnlPercent = ((priceRatio - pos.entryPrice) / pos.entryPrice) * 100;

      if (pnlPercent >= 15 || pnlPercent <= -10) {
        const returnAmount = pos.amountUsd + (pos.amountUsd * (pnlPercent / 100));
        botDatabase.balanceUsd += returnAmount;

        botDatabase.history.unshift({
          id: Date.now(),
          symbol: pos.symbol,
          type: 'SELL',
          reason: pnlPercent >= 15 ? 'TAKE PROFIT (+15%)' : 'STOP LOSS (-10%)',
          pnlPercent: pnlPercent.toFixed(2),
          pnlUsd: (returnAmount - pos.amountUsd).toFixed(2),
          time: new Date().toLocaleTimeString('id-ID')
        });

        botDatabase.positions.splice(i, 1);
      }
    }

    // 2. Cek Beli
    if (botDatabase.positions.length < 3 && botDatabase.balanceUsd >= 100 && tokens.length > 0) {
      const candidate = tokens.find(t => 
        t.safetyStatus !== 'HIGH RISK (Low Liq)' && 
        !botDatabase.positions.some(p => p.address === t.address) &&
        t.priceUsd > 0
      );

      if (candidate) {
        const buyAmount = 100;
        botDatabase.balanceUsd -= buyAmount;

        botDatabase.positions.push({
          address: candidate.address,
          symbol: candidate.symbol,
          name: candidate.name,
          entryPrice: candidate.priceUsd,
          amountUsd: buyAmount,
          buyTime: new Date().toLocaleTimeString('id-ID')
        });

        botDatabase.history.unshift({
          id: Date.now(),
          symbol: candidate.symbol,
          type: 'BUY',
          reason: 'AUTO SIGNAL MATCH',
          pnlPercent: '0.00',
          pnlUsd: '0.00',
          time: new Date().toLocaleTimeString('id-ID')
        });
      }
    }

    return res.json({ success: true, data: botDatabase });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/bot/state', (req, res) => {
  res.json({ success: true, data: botDatabase });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Solana WIN Network Engine running on port ${PORT}`);
});
  
