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
    .filter((note) => note.midi >= 32 && note.midi <= 92 && note.time < MAX_DURATION_SECONDS)
    .map((note) => ({
      midi: Math.round(note.midi),
      start: Math.max(0, Math.round(note.time / stepSeconds)),
      end: Math.max(1, Math.round((note.time + note.duration) / stepSeconds)),
    }))
    // Keep a 16th-note-sized event. Removing it made legitimate fast phrases
    // disappear; voice tracking below is responsible for reducing instability.
    .filter((note) => note.end - note.start >= 1);
  if (!usable.length) throw new Error("演奏可能な音符を検出できませんでした。短く音が明瞭な区間で試してください。");

  const length = Math.min(Math.max(...usable.map((note) => note.end)), Math.ceil(MAX_DURATION_SECONDS / stepSeconds));
  const starts = Array.from({ length }, () => []);
  usable.forEach((note) => { if (note.start < length) starts[note.start].push(note); });
  let active = [];
  const frames = [];
  for (let step = 0; step < length; step += 1) {
    active = active.filter((note) => note.end > step);
    active.push(...starts[step]);
    frames.push([...new Set(active.map((note) => note.midi))].sort((a, b) => b - a));
  }
  const melody = trackVoice(frames, null, "melody");
  const harmony1 = trackVoice(frames, melody, "harmony1");
  const harmony2 = trackVoice(frames, melody, "harmony2");
  const voices = [melody, harmony1, harmony2].map(simplifyVoice);
  return { voices, sourceNotes: usable.length, stepSeconds };
}

function trackVoice(frames, melody, role) {
  const states = frames.map((pitches, index) => {
    const upper = melody?.[index] ?? 93;
    const options = pitches.filter((pitch) => pitch <= upper - (role === "melody" ? 0 : 2));
    return [null, ...options];
  });
  const scores = [];
  const parents = [];
  states.forEach((options, index) => {
    const current = new Map();
    const parent = new Map();
    options.forEach((pitch) => {
      let emission = pitch === null ? -1.1 : 2.2;
      if (pitch !== null && role === "melody") emission += pitch * 0.018;
      if (pitch !== null && role !== "melody" && melody?.[index] !== null) {
        const target = melody[index] - (role === "harmony1" ? 5 : 10);
        emission -= Math.abs(pitch - target) * 0.09;
      }
      if (index === 0) { current.set(pitch, emission); parent.set(pitch, null); return; }
      let bestScore = -Infinity;
      let bestPrevious = null;
      scores[index - 1].forEach((previousScore, previous) => {
        let transition;
        if (pitch === null && previous === null) transition = 0.25;
        else if (pitch === null || previous === null) transition = -1.0;
        else transition = 0.8 - Math.min(Math.abs(pitch - previous), 24) * 0.23;
        const nextScore = previousScore + emission + transition;
        if (nextScore > bestScore) { bestScore = nextScore; bestPrevious = previous; }
      });
      current.set(pitch, bestScore);
      parent.set(pitch, bestPrevious);
    });
    scores.push(current);
    parents.push(parent);
  });
  let last = null;
  let best = -Infinity;
  scores.at(-1).forEach((score, pitch) => { if (score > best) { best = score; last = pitch; } });
  const result = Array(frames.length).fill(null);
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    result[index] = last;
    last = parents[index].get(last);
  }
  return result;
}

function simplifyVoice(sequence) {
  const output = [...sequence];
  for (let start = 0; start < output.length;) {
    const value = output[start];
    let end = start + 1;
    while (end < output.length && output[end] === value) end += 1;
    if (value !== null && end - start < 2) {
      const before = output[start - 1];
      const after = output[end];
      // A one-step gap between equal notes is almost always a split note. Do
      // not delete other short notes: they may be intentional 16th notes.
      if (before !== null && before === after) output.fill(before, start, end);
    }
    start = end;
  }
  for (let index = 1; index < output.length - 1; index += 1) {
    if (output[index] === null && output[index - 1] !== null && output[index - 1] === output[index + 1]) output[index] = output[index - 1];
  }
  return output;
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

function createConverter(tempo) {
  return new AudioToMidiConverter({
    ...audioToMidiDefaults,
    modelUrl,
    maxFileSizeMb: 100,
    maxDurationSeconds: MAX_DURATION_SECONDS,
    tempo,
    onsetThreshold: 0.5,
    frameThreshold: 0.32,
    minimumNoteLength: 3,
    backend: "webgl",
  });
}

async function convertFile(converter, file, label) {
  return converter.convert(file, {
    onStatus: (status) => {
      const labels = { "loading-model": "採譜モデルを読み込み中…", "decoding-audio": `${label}を読み込み中…`, transcribing: `${label}をAIが採譜中…`, "preparing-midi": "MIDIを作成中…" };
      setNotice(labels[status] || "処理中…");
    },
    onProgress: (progress) => setNotice(`${label}をAIが採譜中… ${Math.round(progress * 100)}%`),
  });
}

async function transcribe() {
  if (!selectedFile || busy) return;
  busy = true;
  runButton.disabled = true;
  runButton.textContent = "採譜モデルを準備中…";
  $("#out").classList.remove("show");
  try {
    const tempo = Number(bpm.value);
    const converter = createConverter(tempo);
    const result = await convertFile(converter, selectedFile, "音源");
    const notes = new Midi(result.midiBytes).tracks.flatMap((track) => track.notes);
    const { voices, sourceNotes } = quantizeToVoices(notes, tempo);
    const rendered = voices.map((voice) => renderMml(voice, tempo));
    showTracks(rendered);
    if (midiUrl) URL.revokeObjectURL(midiUrl);
    midiUrl = URL.createObjectURL(result.midiBlob);
    $("#midi-download").href = midiUrl;
    const capped = rendered.some((part) => part.truncated);
    $("#status").textContent = capped
      ? "採譜結果を3パートに分けました。一部は2,400文字の暫定上限で止めています。"
      : "検出した音符を、連続した声部としてメロディ・和音1・和音2に分けました。ゲーム内の試聴で確認してください。";
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
