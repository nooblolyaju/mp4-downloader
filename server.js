const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3456;
const API_KEY = process.env.API_KEY || 'your-secret-key-here';

// 一時ファイル管理（トークン → { path, filename, expiresAt }）
const tempFiles = new Map();
const TEMP_TTL_MS = 15 * 60 * 1000; // 15分で削除

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
    'Accept': '*/*',
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    'Referer': referer,
    'Origin': 'https://www.pornhub.com',
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phdl-'));
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function cleanupExpiredFiles() {
  const now = Date.now();
  for (const [token, info] of tempFiles.entries()) {
    if (info.expiresAt <= now) {
      try {
        if (info.path && fs.existsSync(info.path)) fs.unlinkSync(info.path);
        if (info.dir) removeDir(info.dir);
      } catch (_) {}
      tempFiles.delete(token);
    }
  }
}
setInterval(cleanupExpiredFiles, 60 * 1000);

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
  let thumbnail = null;

  const fvMatch = html.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\});/);
  if (fvMatch) {
    try {
      const fv = JSON.parse(fvMatch[1]);
      if (Array.isArray(fv.mediaDefinitions)) mediaDefinitions = fv.mediaDefinitions;
      if (fv.video_title) title = fv.video_title;
      if (fv.image_url) thumbnail = fv.image_url;
    } catch (_) {}
  }

  if (!mediaDefinitions) {
    const m = html.match(/"mediaDefinitions"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
    if (m) {
      try { mediaDefinitions = JSON.parse(m[1]); } catch (_) {}
    }
  }

  if (!thumbnail) {
    const imgMatch = html.match(/"image_url"\s*:\s*"([^"]+)"/);
    if (imgMatch) thumbnail = imgMatch[1];
  }

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

  if (thumbnail) {
    thumbnail = thumbnail.replace(/\\\//g, '/');
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

  const seen = new Set();
  const unique = formats.filter(f => {
    if (seen.has(f.url)) return false;
    seen.add(f.url);
    return true;
  });

  if (!unique.length) throw new Error('利用可能なフォーマットがありません');

  return { title, thumbnail, formats: unique };
}

async function getSegmentUrls(m3u8Url, referer) {
  const res = await fetch(m3u8Url, { headers: getHeaders(referer) });
  if (!res.ok) throw new Error('m3u8の取得に失敗しました');
  const text = await res.text();

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
    if (bestUrl) return getSegmentUrls(bestUrl, referer);
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

async function downloadSegments(segmentUrls, tempDir, referer) {
  const localFiles = [];

  for (let i = 0; i < segmentUrls.length; i++) {
    const segUrl = segmentUrls[i];
    const localPath = path.join(tempDir, `seg_${String(i).padStart(5, '0')}.ts`);

    const res = await fetch(segUrl, { headers: getHeaders(referer) });
    if (!res.ok) {
      console.warn(`セグメント ${i} 取得失敗: ${res.status}`);
      continue;
    }

    const buffer = await res.buffer();
    fs.writeFileSync(localPath, buffer);
    localFiles.push(localPath);

    if (i % 20 === 0) {
      console.log(`セグメント進捗: ${i + 1}/${segmentUrls.length}`);
    }
  }

  if (localFiles.length === 0) {
    throw new Error('セグメントを1つもダウンロードできませんでした');
  }

  return localFiles;
}

function convertLocalTsToMp4(localFiles, outputPath) {
  return new Promise((resolve, reject) => {
    const listPath = path.join(path.dirname(outputPath), 'concat.txt');
    const listContent = localFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
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
        const last = stderr.split('\n').slice(-8).join('\n');
        reject(new Error('ffmpeg変換に失敗しました\n' + last));
      }
    });

    ff.on('error', reject);
  });
}

// 変換して一時保存し、ダウンロード用トークンを返す
async function prepareDownloadFile(pageUrl, quality) {
  const { title, formats } = await extractFormats(pageUrl);

  let selected = formats[0];
  if (quality) {
    const found = formats.find(
      f => String(f.quality) === String(quality) || String(f.height) === String(quality)
    );
    if (found) selected = found;
  }

  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  const filename = `${safeTitle}_${selected.quality}p.mp4`;

  const tempDir = makeTempDir();
  const outputPath = path.join(tempDir, 'output.mp4');

  if (selected.isHls) {
    console.log('1. m3u8解析中...');
    const segmentUrls = await getSegmentUrls(selected.url, pageUrl);
    console.log(`セグメント数: ${segmentUrls.length}`);

    console.log('2. セグメントダウンロード中...');
    const localFiles = await downloadSegments(segmentUrls, tempDir, pageUrl);

    console.log('3. ffmpegでMP4変換中...');
    await convertLocalTsToMp4(localFiles, outputPath);
  } else {
    const videoRes = await fetch(selected.url, { headers: getHeaders(pageUrl) });
    if (!videoRes.ok) throw new Error('動画の取得に失敗しました');
    const buffer = await videoRes.buffer();
    fs.writeFileSync(outputPath, buffer);
  }

  const token = crypto.randomBytes(16).toString('hex');
  tempFiles.set(token, {
    path: outputPath,
    dir: tempDir,
    filename,
    expiresAt: Date.now() + TEMP_TTL_MS,
  });

  return { token, filename };
}

// 情報取得
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

// ダウンロード準備（変換してトークン発行）
app.post('/api/download', checkKey, async (req, res) => {
  const { url, quality } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URLを入力してください' });
  if (!isPornhubUrl(url)) {
    return res.status(400).json({ error: '有効なPornHubのURLを入力してください' });
  }

  try {
    const { token, filename } = await prepareDownloadFile(url, quality);
    // LINEブラウザ向けに「直リンク」を返す
    res.json({
      ok: true,
      token,
      filename,
      downloadUrl: `/api/file/${token}`,
      expiresInSec: Math.floor(TEMP_TTL_MS / 1000),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'ダウンロードに失敗しました' });
  }
});

// 実際のファイル配信（GETで開ける＝LINEでも保存しやすい）
app.get('/api/file/:token', (req, res) => {
  cleanupExpiredFiles();

  const info = tempFiles.get(req.params.token);
  if (!info || !fs.existsSync(info.path)) {
    return res.status(404).send('ファイルが見つかりません（期限切れの可能性があります）');
  }

  const stat = fs.statSync(info.path);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(info.filename)}`
  );
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  fs.createReadStream(info.path).pipe(res);
});

// ブラウザでそのまま再生したい場合用（inline）
app.get('/api/play/:token', (req, res) => {
  cleanupExpiredFiles();

  const info = tempFiles.get(req.params.token);
  if (!info || !fs.existsSync(info.path)) {
    return res.status(404).send('ファイルが見つかりません（期限切れの可能性があります）');
  }

  const stat = fs.statSync(info.path);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(info.filename)}`
  );
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  fs.createReadStream(info.path).pipe(res);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
