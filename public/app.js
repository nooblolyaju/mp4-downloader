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

    // サムネイル表示
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

  setStatus('変換・ダウンロード準備中...（1〜3分かかることがあります）');
  dlBtn.disabled = true;

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `エラー ${res.status}`);
    }

    // ファイル名取得（必ず.mp4）
    const disp = res.headers.get('Content-Disposition') || '';
    const match = disp.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i);
    let filename = 'video.mp4';
    if (match) {
      filename = decodeURIComponent(match[1] || match[2] || 'video.mp4');
    }
    if (!filename.toLowerCase().endsWith('.mp4')) {
      filename += '.mp4';
    }

    const blob = await res.blob();
    const mp4Blob = new Blob([blob], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(mp4Blob);

    if (isIOS()) {
      const file = new File([mp4Blob], filename, { type: 'video/mp4' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: filename,
          });
          setStatus('共有シートから「ファイルに保存」を選んでください', 'ok');
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
          return;
        } catch (shareErr) {
          console.log('Share failed, fallback...', shareErr);
        }
      }

      setStatus('新しいタブで開きます。長押し →「ファイルに保存」を選んでください', 'ok');
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, 100);

      setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
    } else {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      setStatus('ダウンロードを開始しました（' + filename + '）', 'ok');
    }
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    dlBtn.disabled = false;
  }
});
