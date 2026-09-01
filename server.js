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

// Main UI Route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// PHASE 1: REAL HEALTH CHECK ENDPOINTS

// 1. Tes Koneksi Solana RPC (Primary Mainnet)
app.get('/api/health/rpc', async (req, res) => {
  const startTime = Date.now();
  try {
    const response = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getHealth'
      })
    });
    const latency = Date.now() - startTime;
    const data = await response.json();

    if (data.result === 'ok') {
      return res.json({ status: 'CONNECTED', latency: `${latency}ms`, url: 'solana-mainnet' });
    }
    return res.json({ status: 'DEGRADED', latency: `${latency}ms`, details: data });
  } catch (err) {
    return res.status(500).json({ status: 'DISCONNECTED', error: err.message });
  }
});

// 2. Tes Koneksi DexScreener API
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Core Engine running on port ${PORT}`);
});
        
