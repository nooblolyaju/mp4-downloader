const urlInput = document.getElementById('url');
const keyInput = document.getElementById('key');
const infoBtn = document.getElementById('infoBtn');
const dlBtn = document.getElementById('dlBtn');
const statusEl = document.getElementById('status');
const formatsEl = document.getElementById('formats');

// APIキーを記憶
keyInput.value = localStorage.getItem('ph_api_key') || '';
keyInput.addEventListener('change', () => {
  localStorage.setItem('ph_api_key', keyInput.value);
});

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

infoBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const key = keyInput.value.trim();

  if (!url || !key) {
    return setStatus('URLとAPIキーを入力してください', 'error');
  }

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

    setStatus(`タイトル: ${data.title}`, 'ok');
    formatsEl.innerHTML =
      '<strong>利用可能な画質:</strong><br>' +
      data.formats
        .map(f => `${f.quality || f.height}p （${f.isHls ? 'HLS' : 'MP4'}）`)
        .join('<br>');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    infoBtn.disabled = false;
  }
});

dlBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const key = keyInput.value.trim();

  if (!url || !key) {
    return setStatus('URLとAPIキーを入力してください', 'error');
  }

  setStatus('ダウンロード準備中...（時間がかかる場合があります）');
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
    if (match) {
      filename = decodeURIComponent(match[1] || match[2] || 'video.mp4');
    }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);

    setStatus('ダウンロードを開始しました', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    dlBtn.disabled = false;
  }
});
