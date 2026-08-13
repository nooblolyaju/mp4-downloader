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

// viewkey を取り出す
function getViewkey(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('viewkey') || null;
  } catch {
    return null;
  }
}

// 共通ヘッダー
function getHeaders(referer = 'https://www.pornhub.com/') {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    'Referer': referer,
    'Origin': 'https://www.pornhub.com',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1',
  };
}

// ページからフォーマット情報を抽出（強化版）
async function extractFormats(pageUrl) {
  const viewkey = getViewkey(pageUrl);
  if (!viewkey) {
    throw new Error('viewkey が見つかりません。正しい動画ページのURLを入力してください。');
  }

  // 1. まずページを取得
  const res = await fetch(pageUrl, {
    headers: getHeaders(pageUrl),
    redirect: 'follow',
    timeout: 25000,
  });

  if (!res.ok) {
    throw new Error(`ページの取得に失敗しました (${res.status})`);
  }

  const html = await res.text();

  // 年齢確認やブロックページの簡易チェック
  if (html.includes('geoBlocked') || html.includes('This content is unavailable in your country')) {
    throw new Error('この動画は地域制限により視聴できません（サーバーの所在地の問題）');
  }

  let mediaDefinitions = null;
  let title = 'video';

  // --- 抽出パターンを複数試す ---

  // パターンA: var flashvars_123456 = {...};
  const flashvarsMatch = html.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\});/);
  if (flashvarsMatch) {
    try {
      const fv = JSON.parse(flashvarsMatch[1]);
      if (Array.isArray(fv.mediaDefinitions)) {
        mediaDefinitions = fv.mediaDefinitions;
      }
      if (fv.video_title) title = fv.video_title;
    } catch (_) {}
  }

  // パターンB: "mediaDefinitions": [...]
  if (!mediaDefinitions) {
    const m = html.match(/"mediaDefinitions"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
    if (m) {
      try {
        mediaDefinitions = JSON.parse(m[1]);
      } catch (_) {}
    }
  }

  // パターンC: mediaDefinitions = [...]
  if (!mediaDefinitions) {
    const m = html.match(/mediaDefinitions\s*[:=]\s*(\[[\s\S]*?\])\s*[,;]/);
    if (m) {
      try {
        mediaDefinitions = JSON.parse(m[1]);
      } catch (_) {}
    }
  }

  // パターンD: APIフォールバック
  if (!mediaDefinitions) {
    try {
      const apiRes = await fetch('https://www.pornhub.com/video/get_media_definitions_v2', {
        method: 'POST',
        headers: {
          ...getHeaders(pageUrl),
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams({
          id: viewkey,
          viewkey: viewkey,
        }).toString(),
      });

      if (apiRes.ok) {
        const apiData = await apiRes.json();
        if (Array.isArray(apiData) && apiData.length > 0) {
          mediaDefinitions = apiData;
        }
      }
    } catch (_) {}
  }

  if (!mediaDefinitions || !Array.isArray(mediaDefinitions) || mediaDefinitions.length === 0) {
    throw new Error('動画情報を抽出できませんでした。URLが正しいか、動画が公開されているか確認してください。');
  }

  // タイトルが取れなかった場合のフォールバック
  if (title === 'video') {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1]
        .replace(/\s*-\s*PornHub.*$/i, '')
        .replace(/\s*\|.*$/i, '')
        .trim() || 'video';
    }
  }

  // フォーマット整形
  const formats = mediaDefinitions
    .filter(d => d && d.videoUrl)
    .map(d => {
      let height = 0;
      if (typeof d.quality === 'number') {
        height = d.quality;
      } else if (typeof d.quality === 'string') {
        height = parseInt(d.quality) || 0;
      } else if (Array.isArray(d.quality)) {
        height = Math.max(...d.quality.map(q => parseInt(q) || 0));
      }

      return {
        quality: height || d.quality || 'unknown',
        height,
        url: d.videoUrl,
        isHls: (d.format === 'hls') || String(d.videoUrl).includes('.m3u8'),
      };
    })
    .filter(f => f.url)
    .sort((a, b) => b.height - a.height);

  // 重複除去
  const seen = new Set();
  const uniqueFormats = formats.filter(f => {
    if (seen.has(f.url)) return false;
    seen.add(f.url);
    return true;
  });

  if (!uniqueFormats.length) {
    throw new Error('利用可能なフォーマットが見つかりませんでした');
  }

  return { title, formats: uniqueFormats };
}

// m3u8 からセグメント一覧を取得
async function getSegments(m3u8Url, referer) {
  const res = await fetch(m3u8Url, {
    headers: getHeaders(referer),
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
    if (bestUrl) return getSegments(bestUrl, referer);
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
      const segments = await getSegments(selected.url, url);
      if (!segments.length) throw new Error('セグメントが取得できませんでした');

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

      for (const segUrl of segments) {
        const segRes = await fetch(segUrl, {
          headers: getHeaders(url),
        });
        if (!segRes.ok) continue;
        await pipeline(segRes.body, res, { end: false });
      }
      res.end();
    } else {
      const videoRes = await fetch(selected.url, {
        headers: getHeaders(url),
      });

      if (!videoRes.ok) throw new Error('動画の取得に失敗しました');

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
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
