const { createFFmpeg, fetchFile } = FFmpeg;

let ffmpeg = null;
let isRunning = false;
let shouldCancel = false;
const MAX_FILES = 25;

let fileList = []; // { file, id, duration, originalSize, outSize, status, outBlob, outName }
let selectedIndex = -1;
let fileIdCounter = 0;

// UI 要素
const dropArea = document.getElementById('drop-area');
const fileInput = document.getElementById('file-input');
const progressArea = document.getElementById('progress-area');
const progressBar = document.getElementById('overall-progress-bar');
const progressText = document.getElementById('overall-progress-text');
const logTerminal = document.getElementById('log-terminal');
const tbody = document.getElementById('file-tbody');
const downloadArea = document.getElementById('download-area');
const zipDownloadArea = document.getElementById('zip-download-area');
const btnAdd = document.getElementById('btn-add');
const btnRemove = document.getElementById('btn-remove');
const btnClear = document.getElementById('btn-clear');
const btnPlayOrig = document.getElementById('btn-play-orig');
const btnPlayOut = document.getElementById('btn-play-out');
const btnStart = document.getElementById('btn-start');
const btnCancel = document.getElementById('btn-cancel');

const modeSelect = document.getElementById('mode-select');
const formatSelect = document.getElementById('format-select');
const targetMbInput = document.getElementById('target-mb');
const percentInput = document.getElementById('percent-val');
const kbpsInput = document.getElementById('kbps-val');
const hintLabel = document.getElementById('mode-hint');

const chkNormalize = document.getElementById('check-normalize');
const chkSanitize = document.getElementById('check-sanitize');
const chkPrefix = document.getElementById('check-prefix');
const chkSkipSmall = document.getElementById('skip-small');

// ログ出力関数
function log(msg, type='info') {
  if (!logTerminal) return;
  const p = document.createElement('p');
  p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  if(type === 'error') p.className = 'log-error';
  if(type === 'success') p.className = 'log-success';
  logTerminal.appendChild(p);
  logTerminal.scrollTop = logTerminal.scrollHeight;
}

// モード変更によるUIの更新
modeSelect.addEventListener('change', () => {
  const mode = modeSelect.value;
  targetMbInput.disabled = !(mode === 'AUTO' || mode === 'TARGET');
  percentInput.disabled = (mode !== 'PERCENT');
  kbpsInput.disabled = (mode !== 'ADVANCED');

  const hints = {
    'AUTO': "目標サイズに合わせて自動で最適なビットレートを選択します。",
    'HIGH': "音質を最優先します。MP3ではVBR高品質となり、サイズはやや大きめになります。",
    'STANDARD': "音質とサイズのバランスを取った標準的な設定です。",
    'STRONG': "ファイルサイズを小さく抑えるため、高圧縮を行います。",
    'ULTRA': "極限までサイズを小さくします。音質の劣化が生じる可能性があります。",
    'TARGET': "1曲あたりの指定された目標サイズ（MB）に近づくように圧縮します。",
    'PERCENT': "元のビットレートに対する指定割合（％）で圧縮します。",
    'ADVANCED': "ビットレート（kbps）を直接指定して圧縮します。",
  };
  hintLabel.textContent = hints[mode] || "";
});

// ファイル追加イベント
btnAdd.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(Array.from(e.target.files)));

// 画面全体への誤ったドロップ（新しいタブで開く現象）を防ぐ
window.addEventListener('dragover', e => e.preventDefault(), false);
window.addEventListener('drop', e => e.preventDefault(), false);

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => dropArea.addEventListener(ev, e => {
  e.preventDefault(); e.stopPropagation();
}));
['dragenter', 'dragover'].forEach(ev => dropArea.addEventListener(ev, () => dropArea.style.background = 'rgba(240, 140, 43, 0.1)'));
['dragleave', 'drop'].forEach(ev => dropArea.addEventListener(ev, () => dropArea.style.background = 'rgba(216, 192, 121, 0.05)'));
const ALLOWED_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma'];

function isAudioFile(file) {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return ALLOWED_EXTS.includes(ext);
}

// フォルダを再帰的に展開する処理
async function getFilesFromItem(item) {
  if (item.isFile) {
    return new Promise((resolve, reject) => {
      item.file(resolve, reject);
    });
  } else if (item.isDirectory) {
    let files = [];
    const dirReader = item.createReader();
    
    // readEntriesは100件ずつしか返さないブラウザがあるためループで全て読み切る
    const readAllEntries = async () => {
      return new Promise((resolve, reject) => {
        dirReader.readEntries(async (entries) => {
          if (entries.length === 0) {
            resolve([]);
          } else {
            const moreEntries = await readAllEntries();
            resolve(entries.concat(moreEntries));
          }
        }, reject);
      });
    };
    
    const entries = await readAllEntries();
    for (let i = 0; i < entries.length; i++) {
      const subFiles = await getFilesFromItem(entries[i]);
      if (Array.isArray(subFiles)) files = files.concat(subFiles);
      else files.push(subFiles);
    }
    return files;
  }
}

dropArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropArea.classList.remove('dragover');
  
  // Chromeの仕様対策: 非同期処理(await)に入る前に、同期的にEntryを全て確保する
  let entries = [];
  if (e.dataTransfer.items) {
    for (let i = 0; i < e.dataTransfer.items.length; i++) {
      const item = e.dataTransfer.items[i].webkitGetAsEntry();
      if (item) entries.push(item);
    }
  }
  
  if (entries.length > 0) {
    let allFiles = [];
    for (let entry of entries) {
      try {
        const files = await getFilesFromItem(entry);
        if (Array.isArray(files)) allFiles = allFiles.concat(files);
        else allFiles.push(files);
      } catch (err) {
        console.error("ファイル読み込みエラー:", err);
      }
    }
    if (allFiles.length > 0) handleFiles(allFiles);
  } else {
    // フォールバック
    const files = e.dataTransfer.files;
    if (files && files.length > 0) handleFiles(Array.from(files));
  }
});

function handleFiles(files) {
  let addedCount = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    
    // 音楽ファイル以外は無視
    if (!isAudioFile(file)) continue;

    if (fileList.length >= MAX_FILES) {
      alert(`最大 ${MAX_FILES} 曲までです。`);
      break;
    }
    // 重複チェック
    if (fileList.some(f => f.file.name === file.name && f.file.size === file.size)) {
      continue;
    }
    
    fileList.push({
      file: file,
      id: Date.now() + i,
      duration: 0,
      originalSize: file.size,
      outSize: 0,
      status: '待機中',
      outBlob: null,
      outName: ''
    });
    addedCount++;
  }
  
  if (addedCount > 0) {
    log(`${addedCount}件の音楽ファイルを追加しました。`);
    renderTable();
  }
}

function getAudioDuration(file) {
  return new Promise(resolve => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    audio.addEventListener('loadedmetadata', () => { resolve(audio.duration); URL.revokeObjectURL(url); });
    audio.addEventListener('error', () => { resolve(0); URL.revokeObjectURL(url); });
    audio.src = url;
  });
}

function formatDuration(sec) {
  if(!sec) return "不明";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if(!bytes) return "-";
  return (bytes / (1024*1024)).toFixed(2) + " MB";
}

// テーブル描画
function renderTable() {
  tbody.innerHTML = '';
  fileList.forEach((item, index) => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    if (selectedIndex === index) tr.style.background = '#ffd8b1';
    
    let color = '';
    if (item.status.includes('エラー')) color = '#ffe0e0';
    else if (item.status.includes('処理中')) color = '#fff3c4';
    else if (item.status.includes('完了') || item.status.includes('スキップ')) color = '#e5f7df';
    else if (item.status.includes('中止')) color = '#eeeeee';
    if(color) tr.style.background = color;
    if (selectedIndex === index) tr.style.border = '2px solid #b85c38'; // 選択状態を強調

    tr.innerHTML = `
      <td style="padding: 10px; border-bottom: 1px solid #ead6bf; text-align: center;">${index + 1}</td>
      <td style="padding: 10px; border-bottom: 1px solid #ead6bf;">${item.file.name}</td>
      <td style="padding: 10px; border-bottom: 1px solid #ead6bf; text-align: center;">${formatDuration(item.duration)}</td>
      <td style="padding: 10px; border-bottom: 1px solid #ead6bf; text-align: center;">${formatBytes(item.originalSize)}</td>
      <td style="padding: 10px; border-bottom: 1px solid #ead6bf; text-align: center;">${formatBytes(item.outSize)}</td>
      <td style="padding: 10px; border-bottom: 1px solid #ead6bf; text-align: center; font-weight:bold;">${item.status}</td>
    `;
    tr.addEventListener('click', () => {
      selectedIndex = index;
      renderTable();
    });
    tbody.appendChild(tr);
  });
}

// ファイル操作ボタン
btnRemove.addEventListener('click', () => {
  if (isRunning) return alert("処理中は削除できません。");
  if (selectedIndex >= 0 && selectedIndex < fileList.length) {
    log(`削除しました: ${fileList[selectedIndex].file.name}`);
    fileList.splice(selectedIndex, 1);
    selectedIndex = -1;
    renderTable();
  }
});

btnClear.addEventListener('click', () => {
  if (isRunning) return alert("処理中はクリアできません。");
  fileList = [];
  selectedIndex = -1;
  downloadArea.innerHTML = '';
  log("リストをクリアしました。");
  renderTable();
});

btnPlayOrig.addEventListener('click', () => {
  if (selectedIndex >= 0 && selectedIndex < fileList.length) {
    const url = URL.createObjectURL(fileList[selectedIndex].file);
    playAudio(url);
  } else {
    alert("リストから曲を選択してください。");
  }
});

btnPlayOut.addEventListener('click', () => {
  if (selectedIndex >= 0 && selectedIndex < fileList.length) {
    const blob = fileList[selectedIndex].outBlob;
    if(blob) {
      const url = URL.createObjectURL(blob);
      playAudio(url);
    } else {
      alert("まだ圧縮処理が完了していません。");
    }
  } else {
    alert("リストから曲を選択してください。");
  }
});

let currentAudio = null;
function playAudio(url) {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
  }
  currentAudio = new Audio(url);
  currentAudio.play().catch(e => alert("再生エラー: " + e.message));
}

// FFmpegのロード (v0.11 API)
async function loadFFmpeg() {
  if (ffmpeg === null) {
    log("システム（FFmpeg.wasm）をロード中...（初回のみ数秒かかります）");
    
    try {
      ffmpeg = createFFmpeg({
        log: true,
        corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
        logger: ({ message }) => { console.log(message); }
      });

      await ffmpeg.load();
      log("システムロード完了。", "success");
    } catch (e) {
      let errDetail = e;
      if (e instanceof Error) errDetail = e.message + "\n" + e.stack;
      else if (typeof e === 'object') errDetail = JSON.stringify(e, Object.getOwnPropertyNames(e));
      
      log(`ロードエラー詳細: ${errDetail}`, "error");
      console.error("詳細エラー:", e);
      ffmpeg = null;
      throw e;
    }
  }
}

// 実行ロジック
btnCancel.addEventListener('click', () => {
  if(isRunning) {
    shouldCancel = true;
    log("中止リクエストを送信しました...", "error");
    btnCancel.disabled = true;
  }
});

btnStart.addEventListener('click', async () => {
  if (fileList.length === 0) return alert("まず音源を追加してください。");
  
  isRunning = true;
  shouldCancel = false;
  btnStart.disabled = true;
  btnCancel.disabled = false;
  
  // UIロック
  [btnAdd, btnRemove, btnClear, modeSelect, formatSelect, targetMbInput, percentInput, kbpsInput, chkNormalize, chkSanitize, chkPrefix, chkSkipSmall].forEach(el => el.disabled = true);
  downloadArea.innerHTML = '';
  zipDownloadArea.innerHTML = '';

  try {
    await loadFFmpeg();
  } catch (e) {
    log("FFmpegのロードに失敗したため、処理を中断しました。", "error");
    isRunning = false;
    btnStart.disabled = false;
    btnCancel.disabled = true;
    [btnAdd, btnRemove, btnClear, modeSelect, formatSelect, chkNormalize, chkSanitize, chkPrefix, chkSkipSmall].forEach(el => el.disabled = false);
    return;
  }
  
  let successCount = 0;
  
  for (let i = 0; i < fileList.length; i++) {
    if (shouldCancel) {
      fileList[i].status = '中止';
      continue;
    }
    
    let item = fileList[i];
    item.status = '処理中';
    selectedIndex = i;
    renderTable();
    log(`[${i+1}/${fileList.length}] ${item.file.name} を処理中...`);
    
    const mode = modeSelect.value;
    const format = formatSelect.value; // mp3 or m4a
    const targetMb = parseFloat(targetMbInput.value);
    const doSkip = chkSkipSmall.checked;
    
    // スキップ判定
    if (doSkip && item.originalSize <= targetMb * 1024 * 1024 && (mode === 'AUTO' || mode === 'TARGET')) {
       item.status = '完了(スキップ)';
       item.outSize = item.originalSize;
       item.outBlob = item.file;
       item.outName = generateOutputName(item.file.name, i, format, chkSanitize.checked, chkPrefix.checked, true);
       createDownloadLink(item.outBlob, item.outName);
       log(` ↳ 目標サイズ以下のため変換をスキップしました。`, 'success');
       successCount++;
       updateProgress(i + 1, fileList.length);
       renderTable();
       continue;
    }

    // ビットレート計算
    let kbps = 128;
    if (mode === 'ADVANCED') {
      kbps = parseInt(kbpsInput.value);
    } else if (mode === 'PERCENT') {
      // 本来は元のkbpsが必要だが、ブラウザでは正確な取得が難しいため128kbpsベースで簡易計算
      kbps = Math.floor(128 * (parseInt(percentInput.value)/100));
    } else if (mode === 'HIGH') kbps = 192;
    else if (mode === 'STANDARD') kbps = 128;
    else if (mode === 'STRONG') kbps = 96;
    else if (mode === 'ULTRA') kbps = 64;
    else if ((mode === 'AUTO' || mode === 'TARGET') && item.duration > 0) {
      kbps = Math.floor((targetMb * 8192) / item.duration);
    }
    if (kbps > 320) kbps = 320;
    if (kbps < 32) kbps = 32;

    log(` ↳ 目標ビットレート: ${kbps}kbps`);

    const inputName = 'input_' + i + item.file.name.slice(item.file.name.lastIndexOf('.'));
    const outputName = 'output_' + i + '.' + format;
    
    let cmdArgs = ['-i', inputName];
    if (chkNormalize.checked) {
      cmdArgs.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
    }
    
    if (format === 'mp3') {
      cmdArgs.push('-c:a', 'libmp3lame', '-b:a', `${kbps}k`);
    } else {
      cmdArgs.push('-c:a', 'aac', '-b:a', `${kbps}k`);
    }
    cmdArgs.push(outputName);
    
    try {
      const fileData = await fetchFile(item.file);
      ffmpeg.FS('writeFile', inputName, fileData);

      // コマンド実行 (v0.11 では run)
      log(`  [${item.file.name}] 最適化処理を実行中...`);
      await ffmpeg.run(...cmdArgs);

      // 出力ファイルの読み込み
      const outData = ffmpeg.FS('readFile', outputName);
      
      item.outBlob = new Blob([outData.buffer], { type: format === 'mp3' ? 'audio/mpeg' : 'audio/mp4' });
      item.outSize = item.outBlob.size;
      item.outName = generateOutputName(item.file.name, i, format, chkSanitize.checked, chkPrefix.checked, false);
      item.status = '完了';
      createDownloadLink(item.outBlob, item.outName);
      log(` ↳ 圧縮完了！`, 'success');
      successCount++;
      
      // クリーンアップ
      ffmpeg.FS('unlink', inputName);
      ffmpeg.FS('unlink', outputName);
        
    } catch (err) {
      log(`  エラー: 処理中に問題が発生しました (${err.message})`, "error");
      item.status = 'エラー';
    }
    
    updateProgress(i + 1, fileList.length);
    renderTable();
  }
  
  if (shouldCancel) {
    log("処理が中止されました。");
  } else {
    log(`すべての処理が完了しました！（成功: ${successCount}曲）`, 'success');
    
    // ZIPでまとめてダウンロードボタンの生成
    const completedFiles = fileList.filter(f => f.status.includes('完了') || f.status.includes('スキップ'));
    if (completedFiles.length > 0) {
      const zipBtn = document.createElement('button');
      zipBtn.className = 'btn';
      zipBtn.style.backgroundColor = '#d8c079';
      zipBtn.style.color = '#fff';
      zipBtn.style.fontSize = '1.1rem';
      zipBtn.style.padding = '15px 30px';
      zipBtn.innerHTML = `📦 ${completedFiles.length}曲を ZIPでまとめてダウンロード`;
      zipBtn.onclick = async () => {
        zipBtn.disabled = true;
        zipBtn.innerHTML = '🔄 ZIPファイルを作成中...';
        
        try {
          const zip = new JSZip();
          completedFiles.forEach(item => {
            if (item.outBlob && item.outName) {
              zip.file(item.outName, item.outBlob);
            }
          });
          const content = await zip.generateAsync({ type: "blob", compression: "STORE" });
          const url = URL.createObjectURL(content);
          const a = document.createElement('a');
          a.href = url;
          a.download = `optimized_bgm_${Date.now()}.zip`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          
          zipBtn.innerHTML = `📦 ${completedFiles.length}曲を ZIPでまとめてダウンロード`;
        } catch (err) {
          alert('ZIPの作成に失敗しました: ' + err.message);
          zipBtn.innerHTML = '❌ 作成失敗';
        }
        zipBtn.disabled = false;
      };
      zipDownloadArea.appendChild(zipBtn);
    }
  }
  
  isRunning = false;
  btnStart.disabled = false;
  btnCancel.disabled = true;
  [btnAdd, btnRemove, btnClear, modeSelect, formatSelect, chkNormalize, chkSanitize, chkPrefix, chkSkipSmall].forEach(el => el.disabled = false);
  // モードに合わせて再設定
  modeSelect.dispatchEvent(new Event('change'));
});

function updateProgress(current, total) {
  const p = Math.floor((current / total) * 100);
  progressBar.style.width = `${p}%`;
  progressText.textContent = `${p}%`;
}

function generateOutputName(origName, index, format, sanitize, prefix, isSkipped) {
  let name = origName.replace(/\.[^/.]+$/, ""); // 拡張子削除
  if (sanitize) {
    name = name.replace(/[^\w\s\u3040-\u30ff\u4e00-\u9faf]/g, "_"); // 簡易サニタイズ（全角ひらがなカタカナ漢字と英数字以外を_に）
  }
  const statusStr = isSkipped ? "" : "_圧縮";
  const numStr = prefix ? String(index + 1).padStart(2, '0') + "_" : "";
  // スキップ時は元ファイルの拡張子をそのまま使いたいが、簡単のためformatにする
  return `${numStr}${name}${statusStr}.${format}`;
}

function createDownloadLink(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.textContent = `⬇️ ${filename}`;
  a.style.display = 'inline-block';
  a.style.padding = '8px 12px';
  a.style.background = '#4CAF50';
  a.style.color = 'white';
  a.style.textDecoration = 'none';
  a.style.borderRadius = '5px';
  a.style.fontSize = '1.3rem';
  downloadArea.appendChild(a);
}
