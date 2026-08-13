const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3456;
const API_KEY = process.env.API_KEY || 'your-secret-key-here';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function checkKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
}

function isPornhubUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return /(?:^|\.)pornhub\.com$/.test(hostname);
  } catch {
    return false;
  }
}

function getViewkey(url) {
  try {
    return new URL(url).searchParams.get('viewkey');
  } catch {
    return null;
  }
}

function getHeaders(referer = 'https://www.pornhub.com/') {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    'Referer': referer,
    'Origin': 'https://www.pornhub.com',
  };
}

// 一時フォルダ作成
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phdl-'));
}

// フォルダごと削除
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

// フォーマット抽出
async function extractFormats(pageUrl) {
  const viewkey = getViewkey(pageUrl);
  if (!viewkey) throw new Error('viewkey が見つかりません');

  const res = await fetch(pageUrl, {
    headers: getHeaders(pageUrl),
    redirect: 'follow',
    timeout: 25000,
  });
  if (!res.ok) throw new Error(`ページ取得失敗 (${res.status})`);

  const html = await res.text();

  if (html.includes('geoBlocked') || html.includes('unavailable in your country')) {
    throw new Error('地域制限により視聴できません');
  }

  let mediaDefinitions = null;
  let title = 'video';

  // flashvars_数字
  const fvMatch = html.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\});/);
  if (fvMatch) {
    try {
      const fv = JSON.parse(fvMatch[1]);
      if (Array.isArray(fv.mediaDefinitions)) mediaDefinitions = fv.mediaDefinitions;
      if (fv.video_title) title = fv.video_title;
    } catch (_) {}
  }

  // 別パターン
  if (!mediaDefinitions) {
    const m = html.match(/"mediaDefinitions"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
    if (m) {
      try { mediaDefinitions = JSON.parse(m[1]); } catch (_) {}
    }
  }

  // APIフォールバック
  if (!mediaDefinitions) {
    try {
      const apiRes = await fetch('https://www.pornhub.com/video/get_media_definitions_v2', {
        method: 'POST',
        headers: {
          ...getHeaders(pageUrl),
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams({ id: viewkey, viewkey }).toString(),
      });
      if (apiRes.ok) {
        const data = await apiRes.json();
        if (Array.isArray(data) && data.length) mediaDefinitions = data;
      }
    } catch (_) {}
  }

  if (!mediaDefinitions?.length) {
    throw new Error('動画情報を抽出できませんでした');
  }

  if (title === 'video') {
    const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (t) {
      title = t[1].replace(/\s*-\s*PornHub.*$/i, '').replace(/\s*\|.*$/i, '').trim() || 'video';
    }
  }

  const formats = mediaDefinitions
    .filter(d => d?.videoUrl)
    .map(d => {
      let height = 0;
      if (typeof d.quality === 'number') height = d.quality;
      else if (typeof d.quality === 'string') height = parseInt(d.quality) || 0;
      else if (Array.isArray(d.quality)) height = Math.max(...d.quality.map(q => parseInt(q) || 0));

      return {
        quality: height || 'unknown',
        height,
        url: d.videoUrl,
        isHls: d.format === 'hls' || String(d.videoUrl).includes('.m3u8'),
      };
    })
    .filter(f => f.height > 0)
    .sort((a, b) => b.height - a.height);

  // 重複除去
  const seen = new Set();
  const unique = formats.filter(f => {
    if (seen.has(f.url)) return false;
    seen.add(f.url);
    return true;
  });

  if (!unique.length) throw new Error('利用可能なフォーマットがありません');
  return { title, formats: unique };
}

// ffmpegでHLS → MP4変換
function convertWithFfmpeg(inputUrl, outputPath, referer) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '-headers', `Referer: ${referer}\r\n`,
      '-i', inputUrl,
      '-c', 'copy',          // 再エンコードせずコピー（速い）
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      outputPath,
    ];

    const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });

    ff.on('close', code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        reject(new Error('ffmpeg変換に失敗しました\n' + stderr.slice(-500)));
      }
    });

    ff.on('error', reject);
  });
}

// ダウンロードAPI
app.post('/api/download', checkKey, async (req, res) => {
  const { url, quality } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URLを入力してください' });
  if (!isPornhubUrl(url)) {
    return res.status(400).json({ error: '有効なPornHubのURLを入力してください' });
  }

  let tempDir = null;

  try {
    const { title, formats } = await extractFormats(url);

    let selected = formats[0];
    if (quality) {
      const found = formats.find(f => String(f.quality) === String(quality) || String(f.height) === String(quality));
      if (found) selected = found;
    }

    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const filename = `${safeTitle}_${selected.quality}p.mp4`;

    // ===== HLSの場合はffmpegで変換 =====
    if (selected.isHls) {
      tempDir = makeTempDir();
      const outputPath = path.join(tempDir, 'output.mp4');

      console.log('Converting HLS with ffmpeg...');
      await convertWithFfmpeg(selected.url, outputPath, url);

      const stat = fs.statSync(outputPath);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);

      stream.on('close', () => removeDir(tempDir));
      stream.on('error', () => {
        removeDir(tempDir);
        if (!res.headersSent) res.status(500).end();
      });

      return;
    }

    // ===== 普通のMP4 =====
    const videoRes = await fetch(selected.url, { headers: getHeaders(url) });
    if (!videoRes.ok) throw new Error('動画の取得に失敗しました');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    videoRes.body.pipe(res);

  } catch (err) {
    console.error(err);
    if (tempDir) removeDir(tempDir);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'ダウンロードに失敗しました' });
    }
  }
});

// 情報取得API
app.post('/api/info', checkKey, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URLを入力してください' });
  if (!isPornhubUrl(url)) {
    return res.status(400).json({ error: '有効なPornHubのURLを入力してください' });
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
