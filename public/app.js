const urlInput = document.getElementById('url');
const keyInput = document.getElementById('key');
const infoBtn = document.getElementById('infoBtn');
const dlBtn = document.getElementById('dlBtn');
const proxyBtn = document.getElementById('proxyBtn');
const statusEl = document.getElementById('status');
const formatsEl = document.getElementById('formats');

keyInput.value = localStorage.getItem('vdl_api_key') || '';
keyInput.addEventListener('change', () => {
  localStorage.setItem('vdl_api_key', keyInput.value);
});

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

function isIOS() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
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

    const formats = (data.formats || []).filter(
      (f) => f.quality && f.quality !== 'preview'
    );

    setStatus(`タイトル: ${data.title}（${data.site || 'unknown'}）`, 'ok');

    if (!formats.length) {
      formatsEl.innerHTML =
        '<span style="color:#f44336">利用可能な画質がありません</span>';
      return;
    }

    let html = '<strong>利用可能な画質:</strong><br>';
    html += formats
      .map((f) => {
        const label = f.isHls ? 'HLS→MP4変換' : 'MP4';
        const q = f.quality;
        const suffix =
          typeof q === 'number' || /^\d+$/.test(String(q)) ? 'p' : '';
        return `${q}${suffix} （${label}）`;
      })
      .join('<br>');

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

  setStatus('準備中...（HLSの場合は変換に時間がかかります）');
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

    const blob = await res.blob();
    const disp = res.headers.get('Content-Disposition') || '';
    const match = disp.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i);
    let filename = 'video.mp4';
    if (match) filename = decodeURIComponent(match[1] || match[2] || 'video.mp4');

    const blobUrl = URL.createObjectURL(blob);

    if (isIOS()) {
      setStatus(
        '新しいタブで開きます。長押しして「ファイルに保存」を選んでください',
        'ok'
      );
      setTimeout(() => {
        const opened = window.open(blobUrl, '_blank');
        if (!opened) {
          const a = document.createElement('a');
          a.href = blobUrl;
          a.target = '_blank';
          a.click();
        }
      }, 150);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
    } else {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      setStatus('ダウンロードを開始しました', 'ok');
    }
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    dlBtn.disabled = false;
  }
});

// プロキシ確認（iPhone向け）
proxyBtn.addEventListener('click', async () => {
  const key = keyInput.value.trim();
  if (!key) return setStatus('APIキーを入力してください', 'error');

  setStatus('プロキシ確認中...');
  proxyBtn.disabled = true;

  try {
    const res = await fetch('/api/proxy-check', {
      headers: { 'x-api-key': key },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '確認に失敗しました');

    const onOff = data.proxyEnabled ? 'ON' : 'OFF';
    const ip = data.outboundIp || '不明';
    setStatus(`プロキシ: ${onOff} / 出口IP: ${ip}`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    proxyBtn.disabled = false;
  }
});
