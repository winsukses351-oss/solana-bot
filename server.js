import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/api/tokens/scan', async (req, res) => {
  try {
    const minLiquidity = Number(req.query.minLiquidity) || 1000;
    const minVolume = Number(req.query.minVolume) || 5000;

    const response = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
    const data = await response.json();

    if (!data.pairs) return res.json({ success: true, data: [] });

    const tokens = data.pairs
      .filter(pair => pair.chainId === 'solana')
      .map(pair => {
        const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : new Date();
        const ageHours = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60)));
        return {
          id: pair.pairAddress,
          name: pair.baseToken.name,
          symbol: pair.baseToken.symbol,
          address: pair.baseToken.address,
          priceUsd: parseFloat(pair.priceUsd || 0),
          priceChange24h: pair.priceChange?.h24 || 0,
          volume24h: pair.volume?.h24 || 0,
          liquidityUsd: pair.liquidity?.usd || 0,
          ageHours: ageHours,
          dexUrl: pair.url
        };
      })
      .filter(t => t.liquidityUsd >= minLiquidity && t.volume24h >= minVolume)
      .sort((a, b) => b.volume24h - a.volume24h);

    return res.json({ success: true, count: tokens.length, data: tokens });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/whales', async (req, res) => {
  try {
    const minUsd = Number(req.query.minUsd) || 1000;
    const response = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
    const data = await response.json();

    if (!data.pairs) return res.json({ success: true, data: [] });

    const whaleTrades = [];
    for (const pair of data.pairs.slice(0, 15)) {
      const vol = pair.volume?.h24 || 0;
      if (pair.liquidity?.usd >= 5000 && vol >= minUsd) {
        const isBuy = (pair.priceChange?.m5 || 0) >= 0;
        const estimatedAmount = Math.min(vol * 0.05, 5000);
        if (estimatedAmount >= minUsd) {
          whaleTrades.push({
            id: pair.pairAddress,
            type: isBuy ? 'BUY' : 'SELL',
            token: `${pair.baseToken.name} (${pair.baseToken.symbol})`,
            amountUsd: Number(estimatedAmount.toFixed(2)),
            priceUsd: pair.priceUsd,
            dexUrl: pair.url,
            time: new Date().toLocaleTimeString()
          });
        }
      }
    }
    return res.json({ success: true, data: whaleTrades });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot running on port ${PORT}`);
});
