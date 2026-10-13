(()=>{"use strict";
const $=s=>document.querySelector(s);
const file=$("#file"),drop=$("#drop"),name=$("#name"),go=$("#go"),bpm=$("#bpm"),notice=$("#notice");
const MAX_FILE_BYTES=100*1024*1024,MAX_SECONDS=60,MAX_MML_CHARS=2400,MAX_DECODED_BYTES=256*1024*1024,MAX_DECODE_SECONDS=15*60;
const allowedExt=new Set(["mp3","wav","m4a","ogg","aac","flac","webm"]);
let selected=null,busy=false;
bpm.oninput=()=>{$("#bpmout").value=bpm.value+" BPM"};
function extOf(f){const n=f.name.toLowerCase(),i=n.lastIndexOf(".");return i<0?"":n.slice(i+1)}
function show(msg){notice.textContent=msg}
async function wavPreflight(f){
  const h=await f.slice(0,44).arrayBuffer(); if(h.byteLength<44)return;
  const v=new DataView(h),sig=String.fromCharCode(...new Uint8Array(h,0,4)),wave=String.fromCharCode(...new Uint8Array(h,8,4));
  if(sig!=="RIFF"||wave!=="WAVE")throw Error("壊れたWAVファイルです。");
  const byteRate=v.getUint32(28,true); if(!byteRate)throw Error("WAVの形式を確認できません。");
  if(f.size/byteRate>MAX_DECODE_SECONDS)throw Error("WAVが長すぎます（15分以内にしてください）。");
}
async function choose(f){
  selected=null;go.disabled=true;
  if(!f)return;
  if(!(f instanceof File)){show("ファイルとして読み込めませんでした。");return}
  const ext=extOf(f);
  if(!allowedExt.has(ext)){show("MP3 / WAV / M4A / OGG / AAC / FLAC / WEBM の音声を選んでください。");return}
  if(!f.size){show("空のファイルは解析できません。");return}
  if(f.size>MAX_FILE_BYTES){show("ファイルが大きすぎます。100MB以下の音源にしてください。");return}
  try{if(ext==="wav")await wavPreflight(f)}catch(e){show("選択できません："+e.message);return}
  selected=f;name.textContent=f.name;go.disabled=false;
  show((f.size/1048576).toFixed(1)+" MB を選択。解析は端末内だけで行います。");
}
file.addEventListener("change",e=>choose(e.target.files?.[0]));
["dragenter","dragover"].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.add("drag")}));
["dragleave","drop"].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.remove("drag")}));
drop.addEventListener("drop",e=>{e.preventDefault();choose(e.dataTransfer?.files?.[0])});
const med=a=>{const b=a.filter(Number.isFinite).sort((x,y)=>x-y);return b.length?b[b.length>>1]:null};
function detect(a,sr){let mean=0;for(const x of a)mean+=x;mean/=a.length;let e=0;for(let i=0;i<a.length;i++){a[i]-=mean;e+=a[i]*a[i]}if(Math.sqrt(e/a.length)<.012)return null;let best=0,lag0=0,lo=Math.floor(sr/1100),hi=Math.min(Math.floor(sr/75),a.length>>1);for(let lag=lo;lag<hi;lag++){let v=0;for(let i=0;i<a.length-lag;i++)v+=a[i]*a[i+lag];if(v>best){best=v;lag0=lag}}return lag0?sr/lag0:null}
function note(n,state){const names=["c","c+","d","d+","e","f","f+","g","g+","a","a+","b"],oct=Math.floor(n/12)-1;let s="";if(state.o!==oct){s+="o"+oct+" ";state.o=oct}return s+names[(n%12+12)%12]+"16 "}
function appendToken(m,token){return m.length+token.length<=MAX_MML_CHARS?m+token:null}
go.addEventListener("click",async()=>{
 if(busy||!selected)return;busy=true;go.disabled=true;go.textContent="解析中…";$("#out").classList.remove("show");
 let ctx;
 try{
  ctx=new(window.AudioContext||window.webkitAudioContext)();
  const raw=await selected.arrayBuffer(),buf=await ctx.decodeAudioData(raw);
  const decodedBytes=buf.length*buf.numberOfChannels*4;
  if(buf.duration>MAX_DECODE_SECONDS||decodedBytes>MAX_DECODED_BYTES)throw Error("音源が長すぎるか、展開後の容量が大きすぎます。短い音源に切り出してください。");
  const data=buf.getChannelData(0),sr=buf.sampleRate,lim=Math.min(data.length,sr*MAX_SECONDS),size=4096,hop=1024,frames=[];
  for(let p=0;p+size<lim;p+=hop){const f=new Float32Array(size);f.set(data.subarray(p,p+size));const hz=detect(f,sr);frames.push(hz?Math.round(69+12*Math.log2(hz/440)):null);if(frames.length%120===0){show("解析中… "+Math.round(p/lim*100)+"%");await new Promise(r=>setTimeout(r,0))}}
  const gs=[],g=[];for(const x of frames){if(g.length&&x!==g[g.length-1])gs.push(g.splice(0));g.push(x)}if(g.length)gs.push(g);
  const unit=60/Number(bpm.value)/4,state={o:4};let m="t"+bpm.value+" o4 l16 ",count=0,capped=false;
  outer:for(const x of gs){if(x.length<3)continue;const n=med(x),d=Math.min(64,Math.max(1,Math.round(x.length*hop/sr/unit)));for(let i=0;i<d;i++){const token=n===null?"r16 ":note(n,state),next=appendToken(m,token);if(next===null){capped=true;break outer}m=next;if(n!==null)count++}}
  if(!count)throw Error("安定した音程を拾えませんでした。ボーカルが明瞭な短い部分で試してください。");
  $("#mml").textContent=m.trim();$("#status").textContent=capped?"2,400文字の暫定上限で出力を止めました。ゲーム内の試聴で確認してください。":"主旋律候補を出力しました。ゲーム内の試聴で確認してください。";
  $("#metrics").textContent="検出音："+count+" ／ MML文字数："+m.trim().length+" / 暫定上限 2,400文字。";$("#out").classList.add("show");show("完了。下のコピーを押してゲーム内へ貼り付けてください。");
 }catch(e){show("変換できませんでした："+(e instanceof Error?e.message:"不明なエラー"))}
 finally{if(ctx)await ctx.close().catch(()=>{});busy=false;go.disabled=!selected;go.textContent="主旋律をMMLにする"}
});
$("#copy").addEventListener("click",async()=>{const text=$("#mml").textContent;if(!text)return;try{await navigator.clipboard.writeText(text);$("#copy").textContent="コピー済み"}catch{show("コピーできませんでした。出力欄を長押し／選択してコピーしてください。")}setTimeout(()=>$("#copy").textContent="コピー",1200)});
})();