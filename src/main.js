import { AudioToMidiConverter, audioToMidiDefaults } from "@musicbento/audio-to-midi";
import { Midi } from "@tonejs/midi";

const $ = (selector) => document.querySelector(selector);
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_DURATION_SECONDS = 180;
const MAX_MML_CHARS = 2400;
const ALLOWED_EXTENSIONS = new Set(["mp3", "wav", "m4a", "ogg", "aac", "flac", "webm"]);
const PART_NAMES = ["メロディ", "和音1", "和音2"];

const fileInput = $("#file");
const drop = $("#drop");
const fileName = $("#name");
const runButton = $("#go");
const bpm = $("#bpm");
const notice = $("#notice");
let selectedFile = null;
let busy = false;
let midiUrl = null;

const modelUrl = `${import.meta.env.BASE_URL}model/model.json`;
const converter = new AudioToMidiConverter({
  ...audioToMidiDefaults,
  modelUrl,
  maxFileSizeMb: 100,
  maxDurationSeconds: MAX_DURATION_SECONDS,
  tempo: Number(bpm.value),
  backend: "webgl",
});

function setNotice(message) { notice.textContent = message; }
function extensionOf(file) {
  const index = file.name.lastIndexOf(".");
  return index < 0 ? "" : file.name.slice(index + 1).toLowerCase();
}

function setReady(file) {
  selectedFile = null;
  runButton.disabled = true;
  if (!file) return;
  if (!(file instanceof File) || !ALLOWED_EXTENSIONS.has(extensionOf(file))) {
    setNotice("MP3 / WAV / M4A / OGG / AAC / FLAC / WEBM の音声を選んでください。");
    return;
  }
  if (file.size === 0 || file.size > MAX_FILE_BYTES) {
    setNotice(file.size === 0 ? "空のファイルは解析できません。" : "ファイルが大きすぎます。100MB以下にしてください。");
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  runButton.disabled = false;
  setNotice(`${(file.size / 1048576).toFixed(1)} MB を選択。解析はこの端末のブラウザ内だけで行います。`);
}

function quantizeToVoices(notes, tempo) {
  const stepSeconds = 60 / tempo / 4;
  const usable = notes
    .filter((note) => Number.isFinite(note.midi) && Number.isFinite(note.time) && Number.isFinite(note.duration))
    .filter((note) => note.midi >= 24 && note.midi <= 108 && note.duration >= 0.055 && note.time < MAX_DURATION_SECONDS)
    .map((note) => ({
      midi: Math.round(note.midi),
      start: Math.max(0, Math.round(note.time / stepSeconds)),
      end: Math.max(1, Math.round((note.time + note.duration) / stepSeconds)),
    }));
  if (!usable.length) throw new Error("演奏可能な音符を検出できませんでした。短く音が明瞭な区間で試してください。");

  const length = Math.min(Math.max(...usable.map((note) => note.end)), Math.ceil(MAX_DURATION_SECONDS / stepSeconds));
  const starts = Array.from({ length }, () => []);
  usable.forEach((note) => { if (note.start < length) starts[note.start].push(note); });
  const voices = Array.from({ length: 3 }, () => Array(length).fill(null));
  let active = [];
  for (let step = 0; step < length; step += 1) {
    active = active.filter((note) => note.end > step);
    active.push(...starts[step]);
    const pitches = [...new Set(active.map((note) => note.midi))].sort((a, b) => b - a);
    if (pitches.length) voices[0][step] = pitches[0];
    if (pitches.length > 1) voices[1][step] = pitches[Math.floor((pitches.length - 1) / 2)];
    if (pitches.length > 2) voices[2][step] = pitches[pitches.length - 1];
  }
  return { voices, sourceNotes: usable.length, stepSeconds };
}

const DURATIONS = [
  [16, "1"], [12, "2."], [8, "2"], [6, "4."], [4, "4"], [3, "8."], [2, "8"], [1, ""],
];
const NAMES = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];

function piecesForSteps(steps) {
  const result = [];
  let remaining = steps;
  for (const [value, suffix] of DURATIONS) {
    while (remaining >= value) { result.push(suffix); remaining -= value; }
  }
  return result;
}

function renderMml(sequence, tempo) {
  let mml = `t${tempo}o4l16`;
  let stateOctave = 4;
  let truncated = false;
  for (let start = 0; start < sequence.length;) {
    const value = sequence[start];
    let end = start + 1;
    while (end < sequence.length && sequence[end] === value) end += 1;
    const durations = piecesForSteps(end - start);
    let token = "";
    if (value === null) {
      token = durations.map((suffix) => `r${suffix}`).join("");
    } else {
      const octave = Math.floor(value / 12) - 1;
      const name = NAMES[value % 12];
      token = `${stateOctave === octave ? "" : `o${octave}`}${name}${durations[0]}`;
      for (const suffix of durations.slice(1)) token += `&${name}${suffix}`;
      stateOctave = octave;
    }
    if (mml.length + token.length > MAX_MML_CHARS) { truncated = true; break; }
    mml += token;
    start = end;
  }
  return { mml, truncated };
}

function showTracks(results) {
  const tracks = $("#tracks");
  tracks.replaceChildren();
  results.forEach((result, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "track";
    const header = document.createElement("div");
    header.className = "trackhead";
    const label = document.createElement("span");
    label.textContent = `${PART_NAMES[index]}（${result.mml.length}文字）`;
    const copy = document.createElement("button");
    copy.className = "copy";
    copy.type = "button";
    copy.textContent = "コピー";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(result.mml); copy.textContent = "コピー済み"; }
      catch { setNotice("コピーできませんでした。出力欄を選択してコピーしてください。"); }
      setTimeout(() => { copy.textContent = "コピー"; }, 1200);
    });
    header.append(label, copy);
    const code = document.createElement("pre");
    code.className = "code";
    code.textContent = result.mml;
    wrapper.append(header, code);
    tracks.append(wrapper);
  });
}

async function transcribe() {
  if (!selectedFile || busy) return;
  busy = true;
  runButton.disabled = true;
  runButton.textContent = "採譜モデルを準備中…";
  $("#out").classList.remove("show");
  try {
    const result = await converter.convert(selectedFile, {
      onStatus: (status) => {
        const labels = { "loading-model": "採譜モデルを読み込み中…", "decoding-audio": "音源を読み込み中…", transcribing: "AIが音符を採譜中…", "preparing-midi": "MIDIを作成中…" };
        setNotice(labels[status] || "処理中…");
      },
      onProgress: (progress) => setNotice(`AIが音符を採譜中… ${Math.round(progress * 100)}%`),
    });
    const parsed = new Midi(result.midiBytes);
    const notes = parsed.tracks.flatMap((track) => track.notes);
    const { voices, sourceNotes } = quantizeToVoices(notes, Number(bpm.value));
    const rendered = voices.map((voice) => renderMml(voice, Number(bpm.value)));
    showTracks(rendered);
    if (midiUrl) URL.revokeObjectURL(midiUrl);
    midiUrl = URL.createObjectURL(result.midiBlob);
    $("#midi-download").href = midiUrl;
    const capped = rendered.some((part) => part.truncated);
    $("#status").textContent = capped
      ? "採譜結果を3パートに分けました。一部は2,400文字の暫定上限で止めています。"
      : "採譜結果をメロディ・和音1・和音2に分けました。ゲーム内の試聴で確認してください。";
    $("#metrics").textContent = `AIが検出した音符：${sourceNotes} ／ 各パート上限：2,400文字 ／ テンポ：${bpm.value} BPM`;
    $("#out").classList.add("show");
    setNotice("完了。各パートを個別にコピーして、ゲーム内の対応欄へ貼り付けてください。");
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なエラー";
    const friendly = message === "audio-too-long" ? "音源が長すぎます。3分以内に切り出してください。" : message;
    setNotice(`変換できませんでした：${friendly}`);
  } finally {
    busy = false;
    runButton.disabled = !selectedFile;
    runButton.textContent = "AI採譜して3パートMMLにする";
  }
}

bpm.addEventListener("input", () => { $("#bpmout").value = `${bpm.value} BPM`; });
fileInput.addEventListener("change", (event) => setReady(event.target.files?.[0]));
["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((type) => drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (event) => setReady(event.dataTransfer?.files?.[0]));
runButton.addEventListener("click", transcribe);
