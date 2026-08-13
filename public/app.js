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

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
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

    // 壊れた画質を除外
    const formats = (data.formats || []).filter(f => {
      const q = f.quality || f.height;
      return q && q !== 'null' && q !== 'unknown' && Number(q) > 0;
    });

    setStatus(`タイトル: ${data.title}`, 'ok');

    if (formats.length === 0) {
      formatsEl.innerHTML = '<span style="color:#f44336">利用可能な画質がありません</span>';
      return;
    }

    const hasRealMp4 = formats.some(f => !f.isHls);
    let html = '<strong>利用可能な画質:</strong><br>';
    html += formats
      .map(f => `${f.quality || f.height}p （${f.isHls ? 'HLS' : 'MP4'}）`)
      .join('<br>');

    if (!hasRealMp4) {
      html += `<br><br>
        <span style="color:#ff9800">
          ※ この動画はHLSのみです。<br>
          iPhoneではダウンロードできても再生できない可能性が高いです。<br>
          PCやAndroidで試すことをおすすめします。
        </span>`;
    }

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

  if (!url || !key) {
    return setStatus('URLとAPIキーを入力してください', 'error');
  }

  setStatus('ダウンロード準備中...（ inding）');
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

    // ファイル名を取得
    const disp = res.headers.get('Content-Disposition') || '';
    const match = disp.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i);
    let filename = 'video.mp4';
    if (match) {
      filename = decodeURIComponent(match[1] || match[2] || 'video.mp4');
    }

    // ===== ダウンロード処理 =====
    const blobUrl = URL.createObjectURL(blob);

    if (isIOS()) {
      // iOS向け：新しいタブで開いて、ユーザーに長押し保存してもらう
      setStatus('新しいタブで開きます。長押しして「ビデオを書き出す」または「ファイルに保存」を選んでください', 'ok');
      
      // 少し遅らせてから開く（ユーザー操作の文脈を保つため）
      setTimeout(() => {
        const opened = window.open(blobUrl, '_blank');
        if (!opened) {
          // ポップアップブロックされた場合
          const a = document.createElement('a');
          a.href = blobUrl;
          a.target = '_blank';
          a.rel = 'noopener';
          a.click();
        }
      }, 100);

      // メモリ解放は少し遅らせる
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } else {
      // PC・Android向け
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
