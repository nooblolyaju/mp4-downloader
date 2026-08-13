const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = process.env.PORT || 3456;

// Render の Environment に API_KEY を設定してください
const API_KEY = process.env.API_KEY || 'your-secret-key-here';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// APIキーチェック
function checkKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
}

// PornHub系ドメインかどうか判定
function isPornhubUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return /(?:^|\.)pornhub\.com$/.test(hostname);
  } catch {
    return false;
  }
}

// ページからフォーマット情報を抽出
async function extractFormats(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Referer': 'https://www.pornhub.com/',
    },
    timeout: 20000,
  });

  if (!res.ok) throw new Error(`ページの取得に失敗しました (${res.status})`);
  const html = await res.text();

  let mediaDefinitions = null;

  // パターン1: mediaDefinitions 直接
  const m1 = html.match(/mediaDefinitions\s*[:=]\s*(\[[\s\S]*?\])\s*[,;]/);
  if (m1) {
    try {
      mediaDefinitions = JSON.parse(m1[1]);
    } catch (_) {}
  }

  // パターン2: flashvars
  if (!mediaDefinitions) {
    const m2 = html.match(/flashvars\s*=\s*({[\s\S]*?});/);
    if (m2) {
      try {
        const fv = JSON.parse(m2[1]);
        mediaDefinitions = fv.mediaDefinitions;
      } catch (_) {}
    }
  }

  // パターン3: 別の書き方
  if (!mediaDefinitions) {
    const m3 = html.match(/"mediaDefinitions"\s*:\s*(\[[\s\S]*?\])/);
    if (m3) {
      try {
        mediaDefinitions = JSON.parse(m3[1]);
      } catch (_) {}
    }
  }

  if (!mediaDefinitions || !Array.isArray(mediaDefinitions)) {
    throw new Error('動画情報を抽出できませんでした。URLが正しいか確認してください。');
  }

  const formats = mediaDefinitions
    .filter(d => d && d.videoUrl)
    .map(d => ({
      quality: d.quality || d.height || 'unknown',
      height: parseInt(d.quality || d.height) || 0,
      url: d.videoUrl,
      isHls: (d.format === 'hls') || String(d.videoUrl).includes('.m3u8'),
    }))
    .sort((a, b) => b.height - a.height);

  if (!formats.length) {
    throw new Error('利用可能なフォーマットが見つかりませんでした');
  }

  // タイトル取得
  let title = 'video';
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1]
      .replace(/\s*-\s*PornHub.*$/i, '')
      .replace(/\s*\|.*$/i, '')
      .trim() || 'video';
  }

  return { title, formats };
}

// m3u8 からセグメント一覧を取得
async function getSegments(m3u8Url) {
  const res = await fetch(m3u8Url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.pornhub.com/',
    },
  });

  if (!res.ok) throw new Error('m3u8の取得に失敗しました');
  const text = await res.text();

  // マスタープレイリストの場合は一番高い帯域を選択
  if (text.includes('#EXT-X-STREAM-INF')) {
    const lines = text.split('\n');
    let bestUrl = null;
    let bestBw = 0;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('BANDWIDTH=')) {
        const bw = parseInt(lines[i].match(/BANDWIDTH=(\d+)/)?.[1] || '0');
        const next = lines[i + 1]?.trim();
        if (next && !next.startsWith('#') && bw >= bestBw) {
          bestBw = bw;
          bestUrl = new URL(next, m3u8Url).href;
        }
      }
    }
    if (bestUrl) return getSegments(bestUrl);
  }

  const segments = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) {
      try {
        segments.push(new URL(t, m3u8Url).href);
      } catch (_) {}
    }
  }
  return segments;
}

// ダウンロード本体
app.post('/api/download', checkKey, async (req, res) => {
  const { url, quality } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'URLを入力してください' });
  }

  if (!isPornhubUrl(url)) {
    return res.status(400).json({
      error: '有効なPornHubのURLを入力してください（www.pornhub.com / jp.pornhub.com 両対応）'
    });
  }

  try {
    const { title, formats } = await extractFormats(url);

    // 画質指定がなければ最高画質
    let selected = formats[0];
    if (quality) {
      const found = formats.find(
        f => String(f.quality) === String(quality) || String(f.height) === String(quality)
      );
      if (found) selected = found;
    }

    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const filename = `${safeTitle}_${selected.quality || selected.height}p.mp4`;

    if (selected.isHls) {
      const segments = await getSegments(selected.url);
      if (!segments.length) throw new Error('セグメントが取得できませんでした');

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

      for (const segUrl of segments) {
        const segRes = await fetch(segUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': url,
          },
        });
        if (!segRes.ok) continue;
        await pipeline(segRes.body, res, { end: false });
      }
      res.end();
    } else {
      const videoRes = await fetch(selected.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': url,
        },
      });

      if (!videoRes.ok) throw new Error('動画の取得に失敗しました');

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      await pipeline(videoRes.body, res);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'ダウンロードに失敗しました' });
    }
  }
});

// 情報取得のみ
app.post('/api/info', checkKey, async (req, res) => {
  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'URLを入力してください' });
  }

  if (!isPornhubUrl(url)) {
    return res.status(400).json({
      error: '有効なPornHubのURLを入力してください（www.pornhub.com / jp.pornhub.com 両対応）'
    });
  }

  try {
    const data = await extractFormats(url);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
