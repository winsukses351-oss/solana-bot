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

// Memory Database untuk Bot Simulator State
let botState = {
  active: false,
  balanceUsd: 1000, // Capital awal simulasi $1,000
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

// PHASE 2 & 3: TOKEN SCANNER WITH SAFETY CHECK
app.get('/api/tokens/scan', async (req, res) => {
  try {
    const response = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    const profiles = await response.json();
    if (!Array.isArray(profiles)) return res.json({ success: true, count: 0, data: [] });

    const solanaTokens = profiles.filter(p => p.chainId === 'solana' && p.tokenAddress).slice(0, 15);
    if (solanaTokens.length === 0) return res.json({ success: true, count: 0, data: [] });

    const addresses = solanaTokens.map(t => t.tokenAddress).join(',');
    const pairResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addresses}`);
    const pairData = await pairResponse.json();
    if (!pairData.pairs) return res.json({ success: true, count: 0, data: [] });

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

    const tokens = Array.from(tokenMap.values()).sort((a, b) => b.volume24h - a.volume24h);

    // EKSPLORASI BOT SIMULATOR KETIKA RUNNING
    if (botState.active && tokens.length > 0) {
      runBotEngine(tokens);
    }

    return res.json({ success: true, count: tokens.length, data: tokens });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PHASE 3: WHALE TRACKER
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

// LOGIKA AUTO-TRADING ENGINE
function runBotEngine(scannedTokens) {
  // 1. Eksekusi Jual (Cek TP +15% atau SL -10%)
  botState.positions.forEach((pos, index) => {
    const liveToken = scannedTokens.find(t => t.address === pos.address);
    if (liveToken && liveToken.priceUsd > 0) {
      const pnlPercent = ((liveToken.priceUsd - pos.entryPrice) / pos.entryPrice) * 100;

      if (pnlPercent >= 15 || pnlPercent <= -10) {
        const returnAmount = pos.amountUsd + (pos.amountUsd * (pnlPercent / 100));
        botState.balanceUsd += returnAmount;

        botState.history.unshift({
          id: Date.now(),
          symbol: pos.symbol,
          type: 'SELL',
          reason: pnlPercent >= 15 ? 'TAKE PROFIT (+15%)' : 'STOP LOSS (-10%)',
          pnlPercent: pnlPercent.toFixed(2),
          pnlUsd: (returnAmount - pos.amountUsd).toFixed(2),
          time: new Date().toLocaleTimeString('id-ID')
        });

        botState.positions.splice(index, 1);
      }
    }
  });

  // 2. Eksekusi Beli (Hanya jika posisi terbuka < 3 dan saldo memadai)
  if (botState.positions.length < 3 && botState.balanceUsd >= 100) {
    const candidate = scannedTokens.find(t => 
      t.safetyStatus !== 'HIGH RISK (Low Liq)' && 
      !botState.positions.some(p => p.address === t.address) &&
      t.priceUsd > 0
    );

    if (candidate) {
      const buyAmount = 100; // Tiap posisi $100
      botState.balanceUsd -= buyAmount;

      botState.positions.push({
        address: candidate.address,
        symbol: candidate.symbol,
        name: candidate.name,
        entryPrice: candidate.priceUsd,
        amountUsd: buyAmount,
        buyTime: new Date().toLocaleTimeString('id-ID')
      });

      botState.history.unshift({
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
}

// PHASE 4: BOT CONTROLLER ENDPOINTS
app.get('/api/bot/status', (req, res) => {
  res.json({ success: true, data: botState });
});

app.post('/api/bot/toggle', (req, res) => {
  botState.active = !botState.active;
  res.json({ success: true, active: botState.active });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Solana WIN Network Engine running on port ${PORT}`);
});
        
