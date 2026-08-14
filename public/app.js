const urlInput = document.getElementById('url');
const keyInput = document.getElementById('key');
const infoBtn = document.getElementById('infoBtn');
const dlBtn = document.getElementById('dlBtn');
const statusEl = document.getElementById('status');
const formatsEl = document.getElementById('formats');

keyInput.value = localStorage.getItem('ph_api_key') || '';
keyInput.addEventListener('change', () => {
  localStorage.setItem('ph_api_key', keyInput.value);
});

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isLineBrowser() {
  return /Line\//i.test(navigator.userAgent);
}

infoBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const key = keyInput.value.trim();
  if (!url || !key) return setStatus('URLとAPIキーを入力してください', 'error');

  setStatus('情報を取得中...');
  formatsEl.innerHTML = '';
  infoBtn.disabled = true;

  try {
    const res = await fetch('/api/info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '失敗しました');

    const formats = (data.formats || []).filter(f => Number(f.height) > 0);
    setStatus(`タイトル: ${data.title}`, 'ok');

    if (!formats.length) {
      formatsEl.innerHTML = '<span style="color:#f44336">利用可能な画質がありません</span>';
      return;
    }

    let html = '';
    if (data.thumbnail) {
      html += `
        <div style="margin-bottom:14px;">
          <img src="${data.thumbnail}" alt="thumbnail"
               style="max-width:100%; border-radius:8px; border:1px solid #333; display:block;">
        </div>
      `;
    }

    html += '<strong>利用可能な画質:</strong><br>';
    html += formats.map(f => `${f.quality}p （${f.isHls ? 'HLS → MP4変換' : 'MP4'}）`).join('<br>');
    html += '<br><br><span style="color:#4caf50">※ HLSはサーバーで本物のMP4に変換してからダウンロードします</span>';

    formatsEl.innerHTML = html;
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    infoBtn.disabled = false;
  }
});

dlBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const key = keyInput.value.trim();
  if (!url || !key) return setStatus('URLとAPIキーを入力してください', 'error');

  setStatus('変換中です...（1〜3分かかることがあります）');
  dlBtn.disabled = true;
  formatsEl.innerHTML = '';

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify({ url }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `エラー ${res.status}`);

    const downloadUrl = data.downloadUrl;
    const playUrl = data.token ? `/api/play/${data.token}` : null;
    const filename = data.filename || 'video.mp4';

    // LINE / iPhone向け：直リンクを表示
    let html = `
      <div style="margin-top:12px; padding:14px; background:#222; border-radius:10px; border:1px solid #444;">
        <div style="margin-bottom:10px; color:#4caf50; font-weight:bold;">変換完了: ${filename}</div>
        <div style="display:flex; flex-direction:column; gap:10px;">
          <a href="${downloadUrl}" 
             style="display:block; text-align:center; padding:12px; background:#ff9000; color:#000; border-radius:8px; font-weight:bold; text-decoration:none;">
            📥 ダウンロード（保存）
          </a>
    `;

    if (playUrl) {
      html += `
          <a href="${playUrl}" target="_blank" rel="noopener"
             style="display:block; text-align:center; padding:12px; background:#333; color:#fff; border-radius:8px; font-weight:bold; text-decoration:none;">
            ▶️ 再生する
          </a>
      `;
    }

    html += `
        </div>
        <div style="margin-top:12px; font-size:0.85rem; color:#aaa; line-height:1.5;">
          【LINEの場合】<br>
          1. 「ダウンロード」をタップ<br>
          2. 右上メニュー → 「ブラウザで開く」が出たらそれを使うと保存しやすいです<br>
          3. または長押しして「リンクを保存」/「ファイルに保存」
        </div>
        <div style="margin-top:8px; font-size:0.8rem; color:#888;">
          ※ リンクの有効期限は約15分です
        </div>
      </div>
    `;

    formatsEl.innerHTML = html;
    setStatus('変換完了。下のボタンから保存または再生してください', 'ok');

    // PCなどでは自動でダウンロードも試す
    if (!isLineBrowser() && !isIOS()) {
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    dlBtn.disabled = false;
  }
});
