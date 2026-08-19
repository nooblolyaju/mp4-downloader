const urlInput = document.getElementById('url');
const keyInput = document.getElementById('key');
const infoBtn = document.getElementById('infoBtn');
const dlBtn = document.getElementById('dlBtn');
const proxyBtn = document.getElementById('proxyBtn');
const copyBmBtn = document.getElementById('copyBmBtn');
const bmCodeEl = document.getElementById('bmCode');
const bmStatus = document.getElementById('bmStatus');
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

const BOOKMARKLET = `javascript:(async function(){
  const S='mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN';
  try{
    const m=location.pathname.match(/\\/videos?\\/([a-zA-Z0-9]+)/i);
    if(!m){alert('Iwaraの動画ページで実行してください');return;}
    const id=m[1];
    const meta=await fetch('https://api.iwara.tv/video/'+id,{credentials:'include'}).then(r=>{
      if(!r.ok) throw new Error('API '+r.status);
      return r.json();
    });
    if(meta.message){alert('Iwara: '+(meta.message||'エラー'));return;}
    if(!meta.fileUrl){
      if(meta.embedUrl){alert('埋め込み動画です\\n'+meta.embedUrl);return;}
      alert('ダウンロードできません');return;
    }
    const u=new URL(meta.fileUrl);
    const fileId=u.pathname.replace(/\\/$/,'').split('/').pop();
    const expires=u.searchParams.get('expires');
    const raw=fileId+'_'+expires+'_'+S;
    const buf=await crypto.subtle.digest('SHA-1',new TextEncoder().encode(raw));
    const xVersion=Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
    const files=await fetch(meta.fileUrl,{headers:{'X-Version':xVersion},credentials:'include'}).then(r=>r.json());
    if(!Array.isArray(files)||!files.length){alert('画質一覧が空です');return;}
    const order={Source:4,'540':3,'360':2,preview:0};
    files.sort((a,b)=>(order[b.name]||1)-(order[a.name]||1));
    let dl=null,q='';
    for(const f of files){
      if(!f||f.name==='preview'||!f.src) continue;
      const href=f.src.download||f.src.view;
      if(!href) continue;
      dl=href.startsWith('//')?'https:'+href:href.startsWith('http')?href:'https://'+href;
      q=f.name;
      break;
    }
    if(!dl){alert('URLを取得できませんでした');return;}
    const title=(meta.title||id).slice(0,80);
    if(confirm('取得成功: '+title+' ('+q+')\\n\\nOKで動画を開きます（長押しで保存可）')){
      location.href=dl;
    }
  }catch(e){
    alert('失敗: '+(e&&e.message?e.message:e));
  }
})();`.replace(/\n/g, '');

if (bmCodeEl) bmCodeEl.value = BOOKMARKLET;

if (copyBmBtn) {
  copyBmBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(BOOKMARKLET);
      bmStatus.textContent = 'コピーしました。ブックマークのURL欄に貼り付けてください';
      bmStatus.className = 'status ok';
    } catch {
      if (bmCodeEl) {
        bmCodeEl.focus();
        bmCodeEl.select();
      }
      bmStatus.textContent = 'コピー失敗。下のコードを長押ししてコピーしてください';
      bmStatus.className = 'status error';
    }
  });
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '失敗しました');
    const formats = (data.formats || []).filter((f) => f.quality && f.quality !== 'preview');
    setStatus(`タイトル: ${data.title}（${data.site || 'unknown'}）`, 'ok');
    if (!formats.length) {
      formatsEl.innerHTML = '<span style="color:#f44336">利用可能な画質がありません</span>';
      return;
    }
    formatsEl.innerHTML =
      '<strong>利用可能な画質:</strong><br>' +
      formats
        .map((f) => {
          const label = f.isHls ? 'HLS→MP4変換' : 'MP4';
          const suffix = typeof f.quality === 'number' || /^\d+$/.test(String(f.quality)) ? 'p' : '';
          return `${f.quality}${suffix} （${label}）`;
        })
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
  if (!url || !key) return setStatus('URLとAPIキーを入力してください', 'error');
  setStatus('準備中...');
  dlBtn.disabled = true;
  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
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
      setStatus('新しいタブで開きます。長押しで保存してください', 'ok');
      setTimeout(() => {
        if (!window.open(blobUrl, '_blank')) {
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

proxyBtn.addEventListener('click', async () => {
  const key = keyInput.value.trim();
  if (!key) return setStatus('APIキーを入力してください', 'error');
  setStatus('プロキシ確認中...');
  proxyBtn.disabled = true;
  try {
    const res = await fetch('/api/proxy-check', { headers: { 'x-api-key': key } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '確認に失敗しました');
    setStatus(
      `プロキシ: ${data.proxyEnabled ? 'ON' : 'OFF'} / 出口IP: ${data.outboundIp || '不明'}`,
      'ok'
    );
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    proxyBtn.disabled = false;
  }
});
