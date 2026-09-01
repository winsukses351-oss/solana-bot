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

// PHASE 1: HEALTH CHECK ENDPOINTS
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
    if (data.result === 'ok') {
      return res.json({ status: 'CONNECTED', latency: `${latency}ms` });
    }
    return res.json({ status: 'DEGRADED', latency: `${latency}ms` });
  } catch (err) {
    return res.status(500).json({ status: 'DISCONNECTED', error: err.message });
  }
});

app.get('/api/health/dexscreener', async (req, res) => {
  const startTime = Date.now();
  try {
    const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/solana');
    const latency = Date.now() - startTime;
    if (response.ok) {
      return res.json({ status: 'CONNECTED', latency: `${latency}ms` });
    }
    return res.json({ status: 'ERROR', statusCode: response.status });
  } catch (err) {
    return res.status(500).json({ status: 'DISCONNECTED', error: err.message });
  }
});

// PHASE 2: MULTI-TOKEN SCANNER (Narik Banyak Token Solana Sekaligus)
app.get('/api/tokens/scan', async (req, res) => {
  try {
    // Ambil dari profil token Solana paling aktif/trending
    const response = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana%20pump');
    const data = await response.json();

    if (!data.pairs) return res.json({ success: true, count: 0, data: [] });

    const tokens = data.pairs
      .filter(pair => pair.chainId === 'solana' && pair.baseToken && pair.liquidity?.usd >= 500)
      .map(pair => {
        const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : new Date();
        const ageHours = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60)));
        return {
          id: pair.pairAddress,
          name: pair.baseToken.name || 'Unknown',
          symbol: pair.baseToken.symbol || '???',
          address: pair.baseToken.address,
          priceUsd: parseFloat(pair.priceUsd || 0),
          priceChange24h: pair.priceChange?.h24 || 0,
          volume24h: pair.volume?.h24 || 0,
          liquidityUsd: pair.liquidity?.usd || 0,
          ageHours: ageHours,
          dexUrl: pair.url
        };
      })
      .sort((a, b) => b.volume24h - a.volume24h);

    return res.json({ success: true, count: tokens.length, data: tokens });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Solana WIN Network Engine running on port ${PORT}`);
});
