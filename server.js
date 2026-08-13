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

  const fvMatch = html.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\});/);
  if (fvMatch) {
    try {
      const fv = JSON.parse(fvMatch[1]);
      if (Array.isArray(fv.mediaDefinitions)) mediaDefinitions = fv.mediaDefinitions;
      if (fv.video_title) title = fv.video_title;
    } catch (_) {}
  }

  if (!mediaDefinitions) {
    const m = html.match(/"mediaDefinitions"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
    if (m) {
      try { mediaDefinitions = JSON.parse(m[1]); } catch (_) {}
    }
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
  return { title, formats: unique };
}

// m3u8の中身を取得してセグメントURLリストを返す
async function getSegmentUrls(m3u8Url, referer) {
  const res = await fetch(m3u8Url, { headers: getHeaders(referer) });
  if (!res.ok) throw new Error('m3u8の取得に失敗しました');
  const text = await res.text();

  // マスタープレイリストなら一番高い帯域を選択
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

// セグメントをダウンロードしてローカルに保存
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

// ローカルのtsファイルをffmpegでMP4に変換
function convertLocalTsToMp4(localFiles, outputPath) {
  return new Promise((resolve, reject) => {
    // concat用のリストファイルを作成
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
        // エラーの最後の部分だけ返す
        const last = stderr.split('\n').slice(-8).join('\n');
        reject(new Error('ffmpeg変換に失敗しました\n' + last));
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

    if (selected.isHls) {
      tempDir = makeTempDir();
      const outputPath = path.join(tempDir, 'output.mp4');

      console.log('1. m3u8解析中...');
      const segmentUrls = await getSegmentUrls(selected.url, url);
      console.log(`セグメント数: ${segmentUrls.length}`);

      console.log('2. セグメントダウンロード中...');
      const localFiles = await downloadSegments(segmentUrls, tempDir, url);

      console.log('3. ffmpegでMP4変換中...');
      await convertLocalTsToMp4(localFiles, outputPath);

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

    // 普通のMP4
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
